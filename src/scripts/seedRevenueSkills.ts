/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Habilidades de REVENUE (§19) para el motor: los instructivos que convierten
 * "tengo tools del RMS" en "se hacer revenue management".
 *
 * Por que habilidades y no mas texto en el system prompt: el prompt del agente
 * de operaciones ya cubre TODA la plataforma. Meter ahi el procedimiento
 * completo de cada rutina de revenue se lo cobra a cada turno del chat, incluso
 * cuando el usuario pregunta por una toalla. Con la revelacion progresiva, cada
 * habilidad cuesta UNA linea en el nivel 1 y el cuerpo se carga con `load_skill`
 * solo cuando el modelo decide que le sirve.
 *
 * Ambito `global`: aplican a cualquier agente del motor. Un inquilino que quiera
 * su propia version define una habilidad del mismo nombre en ambito `tenant` y
 * gana por precedencia, sin tocar esto.
 *
 * Idempotente: keyea por `name` + scope global. Correr de nuevo actualiza la
 * descripcion y crea una version nueva del cuerpo SOLO si cambio.
 *
 *   npm run seed:revenue-skills
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { newId } from "../engine/core/ids";
import {
  EngineSkill,
  EngineSkillVersion,
} from "../engine/models/skill.model";
import { InternalUser } from "../modules/users/users.model";
import { EngineAgent } from "../engine/models/agent.model";
import { EngineAgentVersion } from "../engine/models/agentVersion.model";
import {
  OPS_AGENT_SLUG,
  logPublishResult,
  publishOpsAgentVersion,
} from "./lib/engineAgentSync";

interface SkillSeed {
  name: string;
  displayName: string;
  /** NIVEL 1: lo unico que el modelo ve sin cargar la habilidad. */
  description: string;
  /** NIVEL 2: el cuerpo, cargado por `load_skill`. */
  body: string;
  tags: string[];
}

const SKILLS: SkillSeed[] = [
  {
    name: "revision-de-revenue",
    displayName: "Revisión de revenue",
    description:
      "Rutina completa para responder 'cómo venimos' o 'revisá el revenue': qué leer, en qué orden y cómo cerrar con " +
      "recomendaciones accionables en vez de una lista de números. Usala cuando el pedido es una revisión general del negocio.",
    tags: ["revenue", "rms", "playbook"],
    body: [
      "# Revisión de revenue",
      "",
      "Objetivo: pasar de datos a una decisión. Una revisión que termina en números sin recomendación no sirvió de nada.",
      "",
      "## Orden de lectura (no lo cambies sin motivo)",
      "",
      "1. `get_pace_alerts` — arranca por lo que está roto. Te dice qué fechas se despegaron del benchmark.",
      "   Si no hay alertas, el horizonte está sano y la revisión es corta: decilo.",
      "2. `get_revenue_dashboard` (rango pedido, o el mes en curso si no lo aclararon) — KPIs y tendencia.",
      "3. `get_pace_overview` — foto on-the-books por fecha: dónde está la venta hoy y cuánto entró en los últimos 7/30 días.",
      "4. Solo para las fechas problemáticas: `get_competitor_rates_grid` y `list_market_events`.",
      "   No leas la competencia de todo el horizonte 'por las dudas': es ruido y quema contexto.",
      "5. `list_rate_recommendations` con `status: \"suggested\"` — qué propone el motor y sigue sin resolverse.",
      "",
      "**Fuera de la rutina, a propósito**: `get_reservations`, `list_units`/`get_room_states` y",
      "`list_room_categories`. Una revisión de revenue no se hace mirando reservas de a una — el dataset del",
      "RMS ya las agrega en ocupación, ADR, RevPAR y pickup. Traerlas igual llena el chat de tarjetas",
      "operativas que tapan el análisis. Se leen solo si el usuario las pide o si hace falta explicar una",
      "anomalía concreta (por ejemplo, un grupo grande que distorsiona el ADR de una fecha puntual).",
      "",
      "## Cómo cerrar",
      "",
      "- Una recomendación concreta por cada alerta relevante, con el motivo en la misma línea",
      "  (\"el 14/3 va 30% por debajo de su curva y la competencia está 12% más barata → bajar 8%\").",
      "- Si hay recomendaciones pendientes en la bandeja, ofrecé resolverlas ahí mismo: las tarjetas del chat",
      "  ya traen los botones de aceptar/rechazar.",
      "- Las tarjetas y gráficos ya muestran los números. Tu texto es la interpretación, no la tabla.",
      "",
      "## Trampas conocidas",
      "",
      "- **Benchmark genérico**: si `pace.generic` es `true`, la comparación es contra una curva de la industria,",
      "  no contra este hotel. Sirve para orientarse, no para justificar un cambio de tarifa. Decilo siempre.",
      "- **Rango sin datos**: si el dataset viene vacío, verificá la property activa antes de concluir que 'no hubo ventas'.",
      "- **Ocupación alta no es buena noticia por sí sola**: 95% con ADR por debajo del comp-set es plata dejada en la mesa.",
      "  Cruzá siempre ocupación con ADR y con la competencia.",
    ].join("\n"),
  },
  {
    name: "diagnostico-de-fecha-lenta",
    displayName: "Diagnóstico de fecha lenta",
    description:
      "Cómo averiguar por qué una fecha concreta no se está vendiendo y qué hacer al respecto: curva de venta contra " +
      "benchmark, competencia, eventos y decisiones del motor. Usala cuando pregunten por una fecha o un fin de semana puntual.",
    tags: ["revenue", "rms", "pace", "playbook"],
    body: [
      "# Diagnóstico de una fecha lenta",
      "",
      "## 1. Confirmá que está lenta de verdad",
      "",
      "`get_pace_curve` con la `stayDate`. Mirá el `pace` de los últimos puntos:",
      "",
      "- `status: \"slow\"` → la fecha va por debajo de lo que este hotel suele tener vendido a esta anticipación.",
      "- `status: \"no_benchmark\"` o `generic: true` → **no hay dato propio suficiente**. No diagnostiques sobre esa base:",
      "  decí que falta historial y usá la competencia y los eventos como referencia.",
      "- `pace_index` cerca de 1.0 → la fecha va normal. Puede que la percepción del usuario sea la equivocada; mostralo.",
      "",
      "## 2. Buscá la causa, en este orden",
      "",
      "| Hipótesis | Tool | Qué mirar |",
      "|---|---|---|",
      "| Estamos caros | `get_competitor_rates_grid` (rango corto alrededor de la fecha) | nuestra tarifa vs. avg/min del comp-set |",
      "| Hay algo que no vimos | `list_market_events` (from/to alrededor de la fecha) | eventos `approved` y su impacto |",
      "| El motor ya lo detectó | `list_pricing_decisions` (start_date/end_date = la fecha) | `log`, `matchedRuleIds`, `clampApplied` |",
      "| Falta demanda, no precio | `get_revenue_daily` | `searches_total` y `conversion_rate_pct` de esos días |",
      "",
      "La distinción de la última fila es la importante: **pocas búsquedas es un problema de demanda** (marketing, visibilidad,",
      "estacionalidad) y bajar la tarifa no lo arregla. **Muchas búsquedas y poca conversión es un problema de precio o de producto.**",
      "",
      "## 3. Revisá si el motor está atado de manos",
      "",
      "`get_revenue_config`: si `clampApplied` aparece en las decisiones, la sugerencia está chocando contra `minRateUsd`/`maxRateUsd`.",
      "El motor puede estar queriendo bajar y no poder. Eso se resuelve con los guardrails, no con una regla nueva.",
      "",
      "## 4. Recomendá",
      "",
      "Una acción concreta con su justificación y su magnitud. Si implica mover precios, confirmá antes de ejecutar.",
    ].join("\n"),
  },
  {
    name: "reglas-de-pricing",
    displayName: "Reglas de pricing",
    description:
      "Cómo diseñar, simular y crear una regla del motor de pricing sin romper las que ya existen: variables disponibles, " +
      "efecto del orden de evaluación y el dry-run obligatorio. Usala cuando pidan automatizar un ajuste de tarifas.",
    tags: ["revenue", "rms", "reglas", "playbook"],
    body: [
      "# Reglas de pricing",
      "",
      "Una regla es: **si `variable` `operador` `referencia`, entonces `acción`**, acotada a una ventana de anticipación",
      "(`minBW`–`maxBW`, en días entre hoy y el check-in).",
      "",
      "## Variables",
      "",
      "| Variable | Qué mide | Escala |",
      "|---|---|---|",
      "| `occupancy` | ocupación de la fecha | 0-100 (%) |",
      "| `demand` | índice de demanda (búsquedas por fecha de estadía) | 0-100 |",
      "| `availability` | unidades libres | unidades |",
      "| `competitor_1..5` | tarifa del slot N del comp-set | moneda |",
      "| `pickup_7d` / `pickup_30d` | noches ganadas en la ventana | noches |",
      "| `event_impact_score` | impacto del evento `approved` que solapa la fecha | 0-100 |",
      "| `days_to_event` | días al evento `approved` más cercano | días (0 = dentro) |",
      "| `pace_index` | ocupación actual ÷ benchmark propio | 1.0 = normal |",
      "",
      "Operadores: `gt`, `gte`, `eq`, `lte`, `lt`. Acciones: `{ type: 'adjust_pct', value }` (porcentaje sobre la base) o",
      "`{ type: 'set_rate_plan', ratePlanId }`.",
      "",
      "**Ojo con `competitor_N`**: el número es la POSICIÓN en el comp-set, no un competidor fijo. Reordenar el comp-set",
      "con `update_compset` cambia contra quién compara cada regla que ya existe.",
      "",
      "## Procedimiento",
      "",
      "1. `list_pricing_rules` — leé lo que ya hay. **El orden importa: la primera que matchea define la acción.**",
      "   Una regla nueva al final puede no ejecutarse nunca si otra más amplia la tapa.",
      "2. `dry_run_pricing_rule` con la regla propuesta. Devuelve en qué fechas del horizonte hubiera matcheado.",
      "   **Este paso no es opcional**: es la diferencia entre proponer una regla y adivinarla.",
      "3. Mostrale al usuario el resultado del dry-run (el chat lo rinde como gráfico) y pedí confirmación.",
      "4. `create_pricing_rule`. Si hace falta que corra antes que otra, `reorder_pricing_rules` con la lista completa.",
      "",
      "## Criterios",
      "",
      "- Acotá siempre con `minBW`/`maxBW`. Una regla sin ventana de anticipación aplica igual a mañana que a dentro de un año.",
      "- Los `adjust_pct` grandes (>15%) merecen una advertencia explícita antes de crearlos.",
      "- Para apagar una regla, `update_pricing_rule` con `isActive: false`. Borrarla es irreversible y pierde el histórico:",
      "  ofrecé desactivar primero.",
      "- Las reglas trabajan sobre la tarifa base y los guardrails (`minRateUsd`/`maxRateUsd`) las recortan después.",
      "  Si el resultado te sorprende, mirá `clampApplied` en `list_pricing_decisions`.",
    ].join("\n"),
  },
  {
    name: "comp-set-y-competencia",
    displayName: "Comp-set y competencia",
    description:
      "Cómo armar y mantener el conjunto de competidores: descubrimiento automático, alta manual, carga de tarifas y " +
      "lectura de la grilla comparativa. Usala cuando pidan comparar contra la competencia o configurar el comp-set.",
    tags: ["revenue", "rms", "compset", "playbook"],
    body: [
      "# Comp-set y competencia",
      "",
      "Hay dos niveles y se confunden fácil:",
      "",
      "- **Competidores** (`list_competitors`): todos los hoteles cargados para esta property. Pueden ser muchos.",
      "- **Comp-set** (`update_compset`, campo `competitors` de `get_revenue_config`): los **5 slots** que el motor de reglas",
      "  usa como `competitor_1..competitor_5`. Es un subconjunto ordenado, y el orden es semántico.",
      "",
      "## Qué contestar cuando preguntan \"cuáles son mis competidores\"",
      "",
      "Los que están **cargados en el sistema**. La primera llamada es siempre `list_competitors` — nunca `web_search`, nunca",
      "`discover_competitors`. Esa distinción no es un tecnicismo:",
      "",
      "| Fuente | Qué es | Está guardado |",
      "|---|---|---|",
      "| `list_competitors` | el comp-set real del hotel | sí |",
      "| `discover_competitors` | candidatos que salieron de buscar hoteles cercanos en OpenStreetMap | **no** |",
      "| `web_search` | lo que hay en internet | **no** |",
      "",
      "Contestar con las dos últimas es decirle al hotelero que tiene configurado algo que no configuró. Si además de lo",
      "cargado querés mostrar lo que encontraste afuera, van en **dos secciones separadas y rotuladas**: primero los cargados,",
      "después \"encontrados fuera del sistema (todavía no cargados)\", y ofrecé darlos de alta con `create_competitor` o",
      "`confirm_discovered_competitors`. Si `list_competitors` vuelve vacía, decí que no hay ninguno cargado y ofrecé el",
      "descubrimiento — no rellenes el vacío con resultados de internet.",
      "",
      "## Armar el comp-set desde cero",
      "",
      "1. `discover_competitors` — busca hoteles cercanos y los puntúa por proximidad, gama y tamaño. **No guarda nada.**",
      "2. Mostrá los candidatos (el chat los rinde como tarjetas con distancia y score) y pedí cuáles confirmar.",
      "   `suggested: true` marca los que el scoring recomienda, pero la decisión es del hotelero.",
      "3. `confirm_discovered_competitors` con los elegidos, pasando los objetos **tal cual vinieron** del descubrimiento.",
      "4. `update_compset` para definir los 5 slots. Reemplaza la lista entera: incluí también los que ya estaban.",
      "",
      "Si el descubrimiento trae poco o nada, revisá que la property tenga ubicación: `get_revenue_config` → `location`.",
      "Sin lat/lng no hay radio que valga; se arregla con `update_events_config` (lat/lng) o desde el PMS.",
      "",
      "## Tarifas",
      "",
      "- `get_competitor_rates_grid` (`from`/`to`) es la lectura: tarifa por fecha por competidor, con avg/min/max.",
      "  Rangos de hasta ~60 días; el backend rechaza más.",
      "- `upsert_competitor_rates` carga tarifas observadas. La respuesta trae `warnings` con las fechas que se desvían",
      "  mucho del histórico: **mostralas siempre**, casi siempre son errores de tipeo.",
      "- `manualBarUsd` de un competidor es una tarifa de referencia fija; las de la grilla son por fecha y ganan cuando existen.",
      "",
      "## Cómo interpretar",
      "",
      "- Estar por encima del comp-set no es un problema si la ocupación acompaña. Cruzá siempre con `get_pace_overview`.",
      "- Un competidor con `similarityScore` bajo compara mal: si su tarifa es la que dispara una regla, decilo.",
      "- Comparar contra un comp-set de un solo hotel es frágil. Si hay menos de 3 slots cargados, aclaralo al recomendar.",
    ].join("\n"),
  },
  {
    name: "eventos-de-mercado",
    displayName: "Eventos de mercado",
    description:
      "Cómo curar los eventos que mueven la demanda (recitales, deportes, ferias, feriados, vacaciones) y cómo impactan " +
      "en el motor de pricing. Usala cuando pregunten por eventos o haya que aprobar/descartar lo que trajo el sync.",
    tags: ["revenue", "rms", "eventos", "playbook"],
    body: [
      "# Eventos de mercado",
      "",
      "Los eventos entran solos (Ticketmaster, agendas oficiales, feriados, vacaciones escolares, feeds iCal del hotel) y",
      "**nacen como `suggested`**. Un evento sugerido no mueve una sola tarifa: **solo los `approved` alimentan las variables",
      "`event_impact_score` y `days_to_event` del motor de reglas.** Aprobar un evento es, en los hechos, una decisión de pricing.",
      "",
      "## Rutina de curaduría",
      "",
      "1. `list_market_events` con `status: \"suggested\"` y `sort: \"relevance\"`.",
      "2. Para cada uno, la pregunta es una sola: **¿esta gente se hospeda acá?** Un recital a 2 km llena hoteles;",
      "   el mismo recital a 80 km no mueve nada. `distanceKm` y `relevanceScore` son la guía, no la sentencia.",
      "3. `approve_market_event` los que sí, `dismiss_market_event` los que no. Ambos son reversibles.",
      "4. Si el impacto por defecto no refleja la realidad (el hotelero sabe que ese congreso le llena la casa),",
      "   `update_market_event` con `expectedImpactScore` corregido — 0-100.",
      "",
      "## Campos que importan",
      "",
      "- `expectedImpactScore` (0-100): cuánta demanda mueve. Es lo que leen las reglas.",
      "- `relevanceScore` (0-1): 0.5·proximidad + 0.3·categoría + 0.2·duración. Ordena la bandeja; no lo lee el motor.",
      "- `highlighted`: relevancia por encima del umbral de la property.",
      "- `source`: de dónde salió. `manual` son los que cargó el hotel y se borran de verdad; el resto, al borrarlos,",
      "  quedan descartados e inactivos para que el próximo sync no los reviva.",
      "",
      "## Configuración",
      "",
      "`update_events_config` ajusta radio, categorías habilitadas, lookahead, umbral de relevancia y pesos por categoría.",
      "Un hotel corporativo sube el peso de `conference`; uno de playa, el de `festival`. **Cambiar radio, pesos o umbral",
      "re-puntúa todos los eventos vigentes**: avisalo antes de tocarlo.",
      "",
      "Si la lista viene vacía, antes de decir que no hay eventos: `sync_market_events` (429 si ya corrió hace menos de un",
      "minuto — en ese caso esperá, no reintentes en loop) y verificá que la property tenga ubicación cargada.",
    ].join("\n"),
  },
];

async function run(): Promise<void> {
  await connectDB();

  const admin = await InternalUser.findOne({ role: "super_admin" });
  const createdByUserId = admin?.userId ?? "seed-script";

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const seed of SKILLS) {
    const existing = await EngineSkill.findOne({
      name: seed.name,
      scope: "global",
      deletedAt: null,
    });

    if (!existing) {
      const skillId = newId("skill");
      const versionId = newId("skver");
      await EngineSkillVersion.create({
        versionId,
        skillId,
        version: 1,
        body: seed.body,
        description: seed.description,
        changeNote: "seed inicial de habilidades de revenue",
        createdByUserId,
      });
      await EngineSkill.create({
        skillId,
        name: seed.name,
        displayName: seed.displayName,
        description: seed.description,
        scope: "global",
        tenantId: null,
        activeVersionId: versionId,
        status: "active",
        tags: seed.tags,
        createdByUserId,
      });
      created += 1;
      console.log(`✓ creada: ${seed.name}`);
      continue;
    }

    // El cuerpo se versiona; la descripcion y el resto se pisan en el doc.
    const current = existing.activeVersionId
      ? await EngineSkillVersion.findOne({ versionId: existing.activeVersionId }).lean()
      : null;

    const bodyChanged = (current?.body ?? "") !== seed.body;
    if (bodyChanged) {
      const last = await EngineSkillVersion.findOne({ skillId: existing.skillId })
        .sort({ version: -1 })
        .lean();
      const versionId = newId("skver");
      await EngineSkillVersion.create({
        versionId,
        skillId: existing.skillId,
        version: (last?.version ?? 0) + 1,
        body: seed.body,
        description: seed.description,
        changeNote: "actualizacion via seed:revenue-skills",
        createdByUserId,
      });
      existing.activeVersionId = versionId;
    }

    existing.displayName = seed.displayName;
    existing.description = seed.description;
    existing.tags = seed.tags;
    existing.status = "active";
    await existing.save();

    if (bodyChanged) {
      updated += 1;
      console.log(`✓ actualizada (version nueva): ${seed.name}`);
    } else {
      unchanged += 1;
      console.log(`• sin cambios: ${seed.name}`);
    }
  }

  console.log(
    `\n${SKILLS.length} habilidades de revenue — ${created} creadas, ${updated} actualizadas, ${unchanged} sin cambios`,
  );

  // Declararlas en la versión del agente. Crear la habilidad no alcanza: la
  // lista `version.skills` es el SELECTOR que decide cuáles ve el agente, y el
  // nivel 1 (la línea en el prompt) se arma a partir de ahí. Se UNEN con las que
  // ya estaban declaradas para no pisar lo que haya sembrado otro script.
  const engineAgent = await EngineAgent.findOne({
    slug: OPS_AGENT_SLUG,
    deletedAt: null,
  }).lean();
  const currentVersion = engineAgent?.activeVersionId
    ? await EngineAgentVersion.findOne({
        versionId: engineAgent.activeVersionId,
      }).lean()
    : null;
  const merged = [
    ...new Set([...(currentVersion?.skills ?? []), ...SKILLS.map((s) => s.name)]),
  ];
  const published = await publishOpsAgentVersion({
    skills: merged,
    changeNote: `seed:revenue-skills — ${SKILLS.length} habilidades de revenue declaradas`,
  });
  logPublishResult(published, "habilidades");

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("seed:revenue-skills error:", err);
  process.exit(1);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Seed de los playbooks de crecimiento.
 *
 * Publica versión N+1 de cada uno (inmutable, como las skills y las versiones
 * del agente). Correr después de cambiar cualquier cuerpo o regla:
 *
 *   npm run seed:growth-playbooks
 *   npm run verify:playbook-levers    # que toda palanca exista en el catálogo
 *
 * SOBRE LOS CUERPOS: son instructivos, no prompts motivacionales. Cada uno
 * responde cuándo aplica, qué confirmar, qué palancas en qué orden, cómo se
 * mide y qué trampas tiene. La sección "Cómo contarlo" existe porque el mismo
 * diagnóstico se le explica distinto a un dueño primerizo que a un revenue
 * manager, y esa diferencia es la que hace que el plan se ejecute o se ignore.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import {
  GrowthPlaybook,
  type ApplicabilityRule,
  type PlaybookGoal,
  type PlaybookLever,
} from "../modules/growth/playbooks/growthPlaybook.model";

interface Seed {
  playbookId: string;
  name: string;
  summary: string;
  goal: PlaybookGoal;
  applicability: ApplicabilityRule[];
  levers: PlaybookLever[];
  kpis: string[];
  body: string;
}

const SEEDS: Seed[] = [
  // ──────────────────────────────────────────────────────────────────────────
  {
    playbookId: "arranque-sin-historial",
    name: "Arranque sin historial",
    summary:
      "Alojamiento nuevo o sin datos de venta: primero hay que poder vender, después optimizar.",
    goal: "arranque",
    applicability: [
      { path: "identity.monthsOnPlatform", op: "lte", value: 3, weight: 2 },
    ],
    levers: [
      { tool: "update_engine_settings", effort: "min", impact: "alto" },
      { tool: "create_rate_plan", effort: "horas", impact: "alto" },
      { tool: "publish_site_changes", effort: "horas", impact: "alto" },
      { tool: "publish_gbp_profile", effort: "horas", impact: "alto" },
      { tool: "publish_linkhub", effort: "min", impact: "medio" },
      { tool: "import_reviews", effort: "min", impact: "medio" },
    ],
    kpis: ["demand.otb30", "demand.occ30", "presence.visibilityScore"],
    body: `## Cuándo aplica
El alojamiento tiene menos de tres meses en la plataforma, o todavía no hay
datos de venta con los que comparar. No hay ritmo que diagnosticar: hay canales
que no existen.

## Qué confirmar en la foto
- ¿El motor de reservas está activo y tiene al menos un plan de tarifa?
- ¿El sitio está publicado? ¿Y la ficha de Google?
- ¿Hay reseñas de algún lado (importadas o propias)?
- Unidades y categorías cargadas: sin inventario no hay nada que vender.

## Palancas, en orden
1. \`update_engine_settings\` — que el motor pueda recibir reservas. Si está
   inactivo, todo lo demás es decorado: mandás tráfico a una puerta cerrada.
2. \`create_rate_plan\` — sin un plan de tarifa el motor no cotiza. Uno solo,
   flexible, alcanza para arrancar.
3. \`publish_site_changes\` — el sitio propio es el único canal donde no pagás
   comisión. Publicarlo aunque esté simple gana más que perfeccionarlo sin
   publicar.
4. \`publish_gbp_profile\` — la ficha de Google es de dónde viene la mayor parte
   del tráfico local, y es gratis.
5. \`publish_linkhub\` — un enlace único para poner en las redes. Cinco minutos.
6. \`import_reviews\` — si ya tenías reseñas en otra plataforma, traerlas. Cero
   reseñas es la objeción número uno de un huésped que no te conoce.

## Cómo medir
Noches vendidas a 30 días y score de visibilidad, a 30 y 60 días. En un
alojamiento nuevo el número que importa es "¿ya entró la primera reserva por
canal directo?", no el ADR.

## Trampas
- No proponer reglas de pricing ni comp-set: sin historial no hay contra qué
  comparar y las recomendaciones salen de la nada.
- No prometer ocupación. Un alojamiento nuevo tarda; prometer números concretos
  garantiza una decepción medible.
- Si faltan unidades o categorías, ESO es el primer paso, no el motor.

## Cómo contarlo
Principiante: "Antes de pensar en llenarte, hay que poder recibir la reserva.
Son cuatro cosas y las tres primeras se hacen hoy."
Avanzado: "Sin historial no hay pace ni benchmark. El plan es habilitar canales
y empezar a generar la serie."`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    playbookId: "presencia-digital-debil",
    name: "Presencia digital débil",
    summary:
      "El alojamiento funciona pero es invisible: sin sitio publicado, sin ficha de Google o con score de visibilidad bajo.",
    goal: "visibilidad",
    applicability: [
      { path: "presence.visibilityScore", op: "lt", value: 45, weight: 2 },
    ],
    levers: [
      { tool: "publish_site_changes", effort: "horas", impact: "alto" },
      { tool: "update_site_seo_geo", effort: "horas", impact: "alto" },
      { tool: "update_gbp_profile", effort: "horas", impact: "alto" },
      { tool: "generate_gbp_description", effort: "min", impact: "medio" },
      { tool: "publish_linkhub", effort: "min", impact: "medio" },
      { tool: "update_ota_profile", effort: "horas", impact: "medio" },
      { tool: "upsert_social_connection", effort: "min", impact: "bajo" },
    ],
    kpis: ["presence.visibilityScore", "presence.seoScore", "demand.otb30"],
    body: `## Cuándo aplica
El score de visibilidad está por debajo de 45 sobre 100. El alojamiento existe
pero no aparece: quien no lo conoce, no lo encuentra.

## Qué confirmar en la foto
- Sitio publicado y en cuántos idiomas.
- Completitud de la ficha de Google (es el componente que más pesa en el score).
- Completitud de las fichas de OTA y en qué plataformas.
- Score SEO contra score GEO: el primero es buscadores, el segundo es qué tan
  citable sos para asistentes de IA. Suelen estar desparejos.

## Palancas, en orden
1. \`publish_site_changes\` si el sitio no está publicado. Un sitio sin publicar
   es trabajo hecho que no rinde nada.
2. \`update_gbp_profile\` + \`generate_gbp_description\` — la ficha de Google es
   el canal de descubrimiento local más fuerte y suele estar a medio llenar:
   sin descripción, sin horarios, con dos fotos.
3. \`update_site_seo_geo\` — metadatos y datos estructurados. Es lo que hace que
   el sitio aparezca y que un asistente de IA pueda citarlo.
4. \`update_ota_profile\` — una ficha de OTA incompleta convierte peor y además
   te posiciona peor DENTRO de la OTA.
5. \`publish_linkhub\` y \`upsert_social_connection\` — cierre barato.

## Cómo medir
Score de visibilidad a 30 días (se recalcula solo) y noches vendidas a 30 días.
El score se mueve rápido; las reservas tardan más.

## Trampas
- La visibilidad no convierte sola: si el motor está inactivo o sin tarifas,
  este playbook trae gente a una puerta cerrada. Revisá eso primero.
- No proponer "hacer más redes" como paso: publicar en Instagram no mueve el
  score y no es una acción que la plataforma pueda ejecutar por sí sola.

## Cómo contarlo
Principiante: "Tu alojamiento está bien, pero no aparece cuando alguien busca.
Vamos a arreglar dónde te ve la gente."
Avanzado: "El score global está en X con el SEO en Y. El componente que más
arrastra es la ficha de Google; ahí está el mayor retorno por hora."`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    playbookId: "temporada-baja-pace-lento",
    name: "Temporada baja con ritmo lento",
    summary:
      "Se vende por debajo del ritmo habitual en temporada baja: hay que generar demanda, no esperar.",
    goal: "ocupacion",
    applicability: [
      { path: "market.season", op: "in", value: ["baja", "media"], weight: 1 },
      { path: "demand.hasHistory", op: "eq", value: true, weight: 1 },
      { path: "demand.paceIndexAvg", op: "lt", value: 0.9, weight: 2 },
    ],
    levers: [
      { tool: "create_promo", effort: "min", impact: "alto" },
      { tool: "set_day_restrictions", effort: "min", impact: "medio" },
      { tool: "create_pricing_rule", effort: "horas", impact: "alto" },
      { tool: "generate_social_assets", effort: "min", impact: "bajo" },
      { tool: "update_site_whatsapp_button", effort: "min", impact: "bajo" },
    ],
    kpis: ["demand.otb30", "demand.otb90", "demand.occ30"],
    body: `## Cuándo aplica
Temporada baja o media Y el pace index promedio está por debajo de 0,90: se
está vendiendo más lento que en el mismo momento de años anteriores. Hay
historial suficiente para afirmarlo.

## Qué confirmar en la foto
- Cuántas fechas están por debajo del umbral lento (no es lo mismo un mes
  entero flojo que tres fines de semana).
- Si ya hay promociones vigentes: sumar otra encima canibaliza.
- Eventos y fines de semana largos en los próximos 90 días: son las fechas
  donde vale empujar y las que NO hay que descontar.
- Restricciones cargadas: a veces el problema no es el precio, es un mínimo de
  noches que bloquea la venta.

## Palancas, en orden
1. \`create_promo\` con alcance de canal directo. Antes de bajar la tarifa
   pública, dar una razón para reservar directo: es el mismo descuento sin
   pagar comisión.
2. \`set_day_restrictions\` — aflojar mínimos de noches en las fechas lentas.
   Es gratis, inmediato y suele destrabar más que un descuento.
3. \`create_pricing_rule\` para las fechas específicas que están atrasadas, no
   para todo el calendario.
4. \`generate_social_assets\` para difundir la promoción.

## Cómo medir
Noches vendidas a 30 y a 90 días, comparando contra el momento de arranque.
El pickup semanal es la señal temprana: si no se mueve en dos semanas, la
palanca elegida no era la correcta.

## Trampas
- No descontar las fechas con evento cerca: ahí la demanda existe y el
  descuento regala margen.
- Un mínimo de noches mal puesto se parece a un problema de precio y no lo es.
  Revisarlo ANTES de tocar tarifas.
- Bajar la tarifa pública es lo último, no lo primero: es lo más difícil de
  revertir y entrena al mercado a esperar el descuento.

## Cómo contarlo
Principiante: "Estás vendiendo más lento que otros años para estas mismas
fechas. Hay tres cosas para mover, y la más barata es la primera."
Avanzado: "Pace index en X sobre las fechas con benchmark, N por debajo del
umbral. Antes de tocar el BAR, promo de canal directo y revisar restricciones."`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    playbookId: "ocupacion-alta-adr-bajo",
    name: "Se llena barato",
    summary:
      "Ocupación alta con tarifa promedio baja: se está dejando plata en la mesa en las fechas que ya se venden solas.",
    goal: "adr",
    applicability: [
      // La ocupación sale de las filas de pace (venta futura), no del reporte
      // de dashboard: ese es operativo y no trae ocupación como porcentaje.
      { path: "demand.occ30", op: "gt", value: 0.75, weight: 2 },
      { path: "demand.hasHistory", op: "eq", value: true, weight: 1 },
    ],
    levers: [
      { tool: "create_pricing_rule", effort: "horas", impact: "alto" },
      { tool: "accept_rate_recommendation", effort: "min", impact: "alto" },
      { tool: "set_day_restrictions", effort: "min", impact: "medio" },
      { tool: "update_rate_plan", effort: "horas", impact: "medio" },
      { tool: "update_compset", effort: "horas", impact: "medio" },
    ],
    kpis: ["demand.adr", "demand.revenueOtb30", "demand.occ30"],
    body: `## Cuándo aplica
La ocupación de los últimos 30 días está por encima del 75% y hay historial de
venta. Llenarse no es el problema: llenarse rápido y barato, sí.

## Qué confirmar en la foto
- ADR actual y, si hay comp-set configurado, dónde queda contra el mercado.
- Si hay recomendaciones de tarifa sin resolver (son plata ya calculada,
  esperando un click).
- Pace index: si además el ritmo va adelantado, el margen para subir es mayor.
- Cuántas reglas de pricing hay activas: puede que ya exista una que esté
  topeando la tarifa.

## Palancas, en orden
1. \`accept_rate_recommendation\` si hay recomendaciones pendientes. Es lo más
   rápido y ya viene con la fecha y el monto calculados.
2. \`create_pricing_rule\` que suba en las fechas de mayor demanda. Con
   guardrails: una regla sin techo es como no tener regla.
3. \`set_day_restrictions\` — un mínimo de noches en los picos protege el fin de
   semana completo de una reserva de una sola noche.
4. \`update_compset\` si no hay comp-set: sin referencia de mercado, "la tarifa
   está baja" es una corazonada.

## Cómo medir
Tarifa promedio e ingresos de 30 días. Mirar los dos juntos: si la tarifa sube
y los ingresos bajan, subiste de más y perdiste volumen.

## Trampas
- No subir todo el calendario. Subir en las fechas que ya están llenas es
  capturar valor; subir en las flojas es vaciarlas.
- Sin comp-set configurado, no afirmar que la tarifa está por debajo del
  mercado: no hay dato que lo sostenga, sólo la ocupación alta como indicio.
- Una ocupación alta con pocas unidades puede ser ruido estadístico. Mirar el
  inventario antes de sacar conclusiones.

## Cómo contarlo
Principiante: "Te estás llenando, que es la parte difícil. Ahora hay que
cobrar lo que vale, sobre todo en los días que se agotan."
Avanzado: "Ocupación en X con ADR en Y. Hay N recomendaciones sin resolver;
empiezo por ahí y después una regla con guardrail para los picos."`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    playbookId: "dependencia-ota-directo-debil",
    name: "Dependencia de OTAs",
    summary:
      "Las reservas llegan por intermediarios mientras el canal propio está apagado o sin razones para elegirlo.",
    goal: "directo",
    applicability: [
      { path: "presence.otaPlatforms", op: "gte", value: 1, weight: 1 },
      { path: "direct.promosActive", op: "eq", value: 0, weight: 2 },
    ],
    levers: [
      { tool: "update_engine_settings", effort: "min", impact: "alto" },
      { tool: "create_promo", effort: "min", impact: "alto" },
      { tool: "update_site_engine_studio", effort: "horas", impact: "medio" },
      { tool: "update_site_whatsapp_button", effort: "min", impact: "medio" },
      { tool: "publish_linkhub", effort: "min", impact: "medio" },
      { tool: "update_site_metadata", effort: "horas", impact: "bajo" },
    ],
    kpis: ["direct.promosActive", "ops.directSharePct", "demand.otb30"],
    body: `## Cuándo aplica
Hay al menos una ficha de OTA cargada y ninguna promoción vigente en el canal
propio. Cada reserva que entra por un intermediario paga comisión; el canal
directo existe pero no le da al huésped ninguna razón para elegirlo.

## Qué confirmar en la foto
- **El porcentaje de reservas por canal directo.** Es el dato duro de la
  dependencia; las fichas de OTA cargadas sólo dicen dónde estás listado. Si
  dice "sin reservas en el período", no hay dependencia que diagnosticar: el
  problema es otro y este playbook no aplica.
- ¿El motor está activo? Si no, el canal directo no existe, no está débil.
- ¿Hay alguna promoción exclusiva de la web propia?
- ¿El sitio está publicado? Sin sitio no hay dónde poner el motor.

## Palancas, en orden
1. \`update_engine_settings\` si el motor está inactivo. Es la condición de
   todo lo demás.
2. \`create_promo\` exclusiva del canal directo. La regla práctica: que el
   beneficio sea menor que la comisión que pagás. Un 10% directo contra un 15%
   de comisión sigue siendo mejor negocio, y el huésped queda en tu base.
3. \`update_site_engine_studio\` — que el motor se vea y sea usable en el sitio.
   Un buscador escondido abajo de todo no lo usa nadie.
4. \`update_site_whatsapp_button\` — para el huésped que quiere preguntar antes
   de reservar. En muchos mercados cierra más que el formulario.
5. \`publish_linkhub\` — el enlace de las redes tiene que llevar al motor
   propio, no al perfil de una OTA.

## Cómo medir
Ingresos de 30 días y noches vendidas a 30. La señal real es la proporción de
reservas directas, que se ve en el reporte del motor.

## Trampas
- No proponer sacar las OTAs. Son canal de descubrimiento: el huésped te
  encuentra ahí y reserva directo la próxima vez. Sacarlas de golpe corta la
  demanda antes de que el canal propio la reemplace.
- El descuento directo no puede violar la paridad tarifaria pactada con la OTA.
  Por eso conviene un beneficio (desayuno, late check-out, upgrade) antes que
  un descuento sobre la tarifa publicada.

## Cómo contarlo
Principiante: "Cada reserva que entra por una de esas plataformas te cuesta una
comisión. Vamos a darle al huésped un motivo para reservarte a vos directo."
Avanzado: "N plataformas cargadas y cero promos de canal directo. El primer
paso es un beneficio directo que no rompa paridad."`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    playbookId: "reputacion-floja",
    name: "Reputación floja o desatendida",
    summary:
      "Rating bajo o reseñas sin responder: la reputación frena la conversión de todo lo demás.",
    goal: "reputacion",
    applicability: [
      { path: "reputation.reviews", op: "gt", value: 0, weight: 1 },
      { path: "reputation.respondedRatio", op: "lt", value: 0.5, weight: 2 },
    ],
    levers: [
      { tool: "respond_review", effort: "min", impact: "alto" },
      { tool: "import_reviews", effort: "min", impact: "medio" },
      { tool: "update_ota_profile", effort: "horas", impact: "medio" },
      { tool: "generate_ota_description", effort: "min", impact: "bajo" },
    ],
    kpis: ["reputation.rating", "reputation.responded", "reputation.reviews"],
    body: `## Cuándo aplica
Hay reseñas y menos de la mitad están respondidas. La reputación es el filtro
por el que pasa todo el tráfico que generen los otros playbooks: sin esto, más
visitas es más gente que se va.

## Qué confirmar en la foto
- Rating promedio y cantidad de reseñas (un 4,0 sobre 8 reseñas no es lo mismo
  que un 4,0 sobre 300).
- Cuántas de los últimos 90 días: una reputación vieja pesa menos que una viva.
- Proporción respondidas.

## Palancas, en orden
1. \`respond_review\` — empezar por las negativas recientes. Una respuesta
   pública y concreta a una crítica convence más al que lee que diez elogios:
   muestra que hay alguien atendiendo.
2. \`import_reviews\` si hay reseñas en plataformas que no están cargadas.
   Volumen y frescura mueven el promedio más que cualquier otra cosa.
3. \`update_ota_profile\` — el texto de la ficha es lo que fija la expectativa.
   Muchas reseñas malas son expectativas mal puestas, no servicio malo.

## Cómo medir
Rating promedio, cantidad de reseñas respondidas y reseñas nuevas en 90 días.
El rating se mueve lento: con pocas reseñas hace falta mucho volumen nuevo para
correr el promedio.

## Trampas
- Nunca proponer borrar reseñas negativas. Existe la herramienta y es la peor
  decisión posible: elimina la prueba de que respondés y deja el perfil sin
  historia.
- No prometer que el rating va a subir a un número. Con N reseñas acumuladas,
  la aritmética manda.
- Responder con plantilla es peor que no responder: se nota y se lee como
  desinterés.

## Cómo contarlo
Principiante: "Cuando alguien duda entre vos y otro, lee las reseñas y mira si
el hotel contesta. Hoy la mitad quedaron sin respuesta."
Avanzado: "Rating X sobre N reseñas, respondidas por debajo del 50%. Prioridad
a las negativas de los últimos 90 días, que son las que pesan en la decisión."`,
  },
];

async function main() {
  await connectDB();

  let published = 0;
  for (const seed of SEEDS) {
    const latest = await GrowthPlaybook.findOne({ playbookId: seed.playbookId })
      .sort({ version: -1 })
      .lean();

    // Si nada cambió, no se publica: versiones idénticas ensucian el historial
    // y hacen imposible saber cuál fue el cambio que movió una respuesta.
    if (latest && sameContent(latest as any, seed)) {
      console.log(`= ${seed.playbookId} v${latest.version} (sin cambios)`);
      continue;
    }

    const version = (latest?.version ?? 0) + 1;
    await GrowthPlaybook.create({ ...seed, version, active: true });
    // Las versiones son inmutables pero sólo la última está activa: así el
    // resolver no tiene que decidir y el historial queda para auditar.
    await GrowthPlaybook.updateMany(
      { playbookId: seed.playbookId, version: { $lt: version } },
      { $set: { active: false } },
    );
    console.log(`✓ ${seed.playbookId} v${version} publicado`);
    published++;
  }

  // Playbooks que ya no están en el seed: se desactivan, no se borran. Un plan
  // viejo puede referenciarlos y su cuerpo explica por qué se propuso eso.
  const ids = SEEDS.map((s) => s.playbookId);
  const retired = await GrowthPlaybook.updateMany(
    { playbookId: { $nin: ids }, active: true },
    { $set: { active: false } },
  );
  if (retired.modifiedCount) {
    console.log(`· ${retired.modifiedCount} playbooks fuera del seed desactivados`);
  }

  console.log(
    `\n${SEEDS.length} playbooks en el catálogo, ${published} versiones nuevas.`,
  );
  await mongoose.disconnect();
}

function sameContent(a: any, b: Seed): boolean {
  return (
    a.name === b.name &&
    a.summary === b.summary &&
    a.body === b.body &&
    a.goal === b.goal &&
    JSON.stringify(a.applicability?.map(strip)) ===
      JSON.stringify(b.applicability.map(strip)) &&
    JSON.stringify(a.levers?.map(strip)) === JSON.stringify(b.levers.map(strip)) &&
    JSON.stringify(a.kpis) === JSON.stringify(b.kpis)
  );
}

/** Quita lo que Mongoose agrega para poder comparar con el seed. */
function strip(x: any): any {
  const { _id, $__parent, $__, __v, ...rest } = x ?? {};
  return Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

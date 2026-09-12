/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HABILIDADES BASE de Roombir IA (§19, revelación progresiva).
 *
 * Con el alcance total del catálogo, el agente puede hacer casi todo lo que
 * hace una persona en el PMS. Eso mueve el problema: ya no es "¿tendrá la
 * herramienta?", es "¿la va a usar bien?". Estas habilidades son el criterio.
 *
 * Por qué habilidades y no más prompt: el prompt del agente de operaciones ya
 * cubre toda la plataforma y se lo cobra a CADA turno, incluso cuando el
 * usuario pregunta por una toalla. Con la revelación progresiva, cada
 * habilidad cuesta una línea en el nivel 1 y el cuerpo se carga con
 * `load_skill` sólo cuando el modelo decide que le sirve.
 *
 * La primera, `acciones-irreversibles`, es la que el usuario pidió
 * explícitamente: qué NO se hace de una, y cómo se llega a lo que sí se hace.
 * Ojo con la división de trabajo: el freno real es el gate del runtime
 * (`confirmationPolicy.ts` + la tarjeta de confirmación), no esta habilidad.
 * Acá va el criterio de cuándo siquiera proponer una acción así; el runtime se
 * encarga de que el modelo no la pueda ejecutar solo.
 *
 * Ámbito `global`: aplican a cualquier agente del motor. Un inquilino que
 * quiera su propia versión define una habilidad del mismo nombre en ámbito
 * `tenant` y gana por precedencia, sin tocar esto.
 *
 * Idempotente: keyea por `name` + scope global. Correr de nuevo actualiza la
 * descripción y crea una versión nueva del cuerpo SÓLO si cambió.
 *
 *   npm run seed:base-skills
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { newId } from "../engine/core/ids";
import { EngineSkill, EngineSkillVersion } from "../engine/models/skill.model";
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
  /** NIVEL 1: lo único que el modelo ve sin cargar la habilidad. */
  description: string;
  /** NIVEL 2: el cuerpo, cargado por `load_skill`. */
  body: string;
  tags: string[];
}

const SKILLS: SkillSeed[] = [
  {
    name: "acciones-irreversibles",
    displayName: "Acciones irreversibles y borrados",
    description:
      "Qué hacer antes de borrar, vaciar o migrar algo: cómo medir el alcance real, qué contarle al usuario y cómo funciona la tarjeta de confirmación. " +
      "Cargala apenas el pedido incluya borrar, eliminar, vaciar, resetear, migrar o cambiar la moneda base.",
    tags: ["seguridad", "borrado", "confirmacion", "base"],
    body: [
      "# Acciones irreversibles y borrados",
      "",
      "## Lo primero: no sos vos el que confirma",
      "",
      "Los borrados y las acciones irreversibles NO se ejecutan cuando las llamás. El runtime las",
      "frena y le muestra al usuario una tarjeta con un botón. Vos recibís un resultado que dice",
      "`confirmation_required`: eso significa que **no pasó nada todavía**.",
      "",
      "Cuando lo recibas:",
      "",
      "- Explicá en una o dos frases QUÉ se va a borrar o cambiar, con números concretos.",
      "- Decí que no hay vuelta atrás si la tarjeta es de las que piden escribir el nombre.",
      "- Y pará. No vuelvas a llamar la tool, no llames otra parecida, no busques otro camino.",
      "  La tarjeta ya está en pantalla y el usuario decide.",
      "",
      "Nunca digas 'listo', 'eliminado' o 'ya lo hice' antes de ver el resultado real de la ejecución.",
      "Es el error más caro que podés cometer acá: el usuario se queda tranquilo con algo que no pasó,",
      "o peor, cree que perdió algo que sigue estando.",
      "",
      "## Antes de proponer un borrado: medí el alcance",
      "",
      "Casi siempre el usuario pide algo más chico de lo que dice. 'Borrá la web' suele ser 'sacá esta",
      "sección', y 'limpiá las reseñas' suele ser 'borrá estas tres'. Antes de ir al borrado grande:",
      "",
      "1. Leé lo que se va a tocar (`get_page_content`, `list_reviews`, `get_currency_migration`…).",
      "2. Contá cuántas cosas son y decilo: 'son 14 páginas y 3 idiomas', no 'todo el sitio'.",
      "3. Ofrecé la alternativa reversible si existe, y recién si el usuario la descarta seguís:",
      "   - En el builder, casi todo se resuelve editando o quitando secciones puntuales",
      "     (`edit_page_content`, `remove_page_component`), que van al BORRADOR y se deshacen con",
      "     `discard_site_draft`. `reset_page_content` / `reset_site_variant_content` /",
      "     `reset_whole_site_content` no se deshacen.",
      "   - Despublicar no es borrar: `update_page_settings` con status inactive saca una página",
      "     de la web sin perderla.",
      "   - Un usuario que no tiene que entrar más: `update_company_user_status` lo desactiva y",
      "     conserva su historial; `remove_company_user` lo saca.",
      "",
      "## Las migraciones son de dos pasos, a propósito",
      "",
      "Moneda base (`open_currency_migration`) y modelo de unidades (`open_unit_migration`) abren un",
      "BORRADOR y calculan un preview. Abrir el borrador no cambia nada del hotel. Lo que no se",
      "deshace es el commit.",
      "",
      "Entre uno y otro, tu trabajo es el preview: leelo, contá cuántas reservas, tarifas y servicios",
      "se tocan, y mostrá los casos raros (reservas con monto manual, tarifas que hay que clonar o",
      "mover). Si el usuario quiere ajustar algo, están `set_migration_rate`,",
      "`set_migration_reservation_override`, `update_unit_migration_preview` y",
      "`set_unit_migration_rate_plan_strategy`. Si se arrepiente, `cancel_*` descarta el borrador sin",
      "consecuencias.",
      "",
      "## Lo que no se hace desde el chat",
      "",
      "- Cambiar la contraseña de alguien. Se hace desde Perfil en el PMS.",
      "- Crear una empresa nueva. El alta va por invitación, fuera del PMS.",
      "- Borrar las plantillas de sitio de la plataforma: son de Roombir, no del hotel.",
      "",
      "Si te lo piden, decilo en una frase y ofrecé el camino real. No lo registres como",
      "'funcionalidad faltante': existe, pero no por acá.",
    ].join("\n"),
  },

  {
    name: "editar-una-pagina-web",
    displayName: "Editar una página del sitio",
    description:
      "Cómo cambiar textos, imágenes y secciones de una web del hotel sin romperla: leer primero, editar por path, y publicar como paso aparte. " +
      "Cargala cuando el pedido sea cambiar algo de la web, el sitio, una página, el encabezado o el pie.",
    tags: ["builder", "sitios", "marketing", "base"],
    body: [
      "# Editar una página del sitio",
      "",
      "## El modelo mental",
      "",
      "Un sitio (`siteId`) tiene una variante por idioma (`subSiteId`), y cada variante tiene páginas.",
      "El contenido de una página son SECCIONES (componentes) con propiedades anidadas.",
      "",
      "Vos no reescribís el árbol. Trabajás por `path`: leés y editás valores puntuales.",
      "",
      "## La secuencia, siempre igual",
      "",
      "1. `list_site_projects` → de qué sitio y variante estamos hablando. Si el hotel tiene uno solo,",
      "   no preguntes: usalo y decilo.",
      "2. `get_page_content` → devuelve las secciones y un índice de cada texto/imagen con su `path`.",
      "   Si la página es grande, acotá con `componentIndex` o `contains`.",
      "3. `edit_page_content` → los cambios, con los `path` EXACTOS del paso 2. No inventes paths:",
      "   la herramienta sólo reemplaza valores que ya existen y rechaza todo lo demás.",
      "4. `publish_site_changes` → recién acá sale al aire.",
      "",
      "Saltarte el paso 2 no funciona. Es la diferencia entre cambiar un título y romper una página.",
      "",
      "## Nada sale al aire solo",
      "",
      "Todas las ediciones van al BORRADOR. La web publicada no cambia hasta que publicás. Decíselo al",
      "usuario cada vez — es la razón por la que puede pedirte cambios con tranquilidad:",
      "",
      "- `get_site_draft` → qué hay pendiente de publicar.",
      "- `discard_site_draft` → tirar el borrador y volver a lo publicado.",
      "- `publish_site_changes` → sacarlo al aire.",
      "",
      "Si el usuario pidió tres cambios, hacé los tres y publicá una vez. No publiques después de cada",
      "edición.",
      "",
      "## Estructura de la página",
      "",
      "- Agregar 'otra tarjeta', 'otro servicio', 'otro testimonio': `duplicate_page_component` y",
      "  después `edit_page_content` sobre la copia. Es la única forma de sumar contenido sin",
      "  inventar un árbol.",
      "- Reordenar: `move_page_component`.",
      "- Sacar una sección: `remove_page_component` (va al borrador, se deshace).",
      "",
      "## Encabezado y pie",
      "",
      "`get_site_global_content` / `edit_site_global_content` con `scope: 'top'` o `'bottom'`.",
      "Avisá siempre que eso aparece en TODAS las páginas del sitio.",
      "",
      "## Lo que NO es contenido",
      "",
      "- Título SEO, meta description, URL, estado de la página: `update_page_settings`.",
      "- Dominio propio: `add_site_domain` + `check_site_domain_dns`. El dominio no anda hasta que el",
      "  DNS apunte bien; decilo antes de que el usuario crea que quedó roto.",
      "- Otro idioma: `create_page_translation` copia la página y después traducís los textos con",
      "  `edit_page_content` sobre la variante destino.",
    ].join("\n"),
  },

  {
    name: "alta-y-accesos-de-usuarios",
    displayName: "Alta y accesos del equipo",
    description:
      "Cómo sumar a alguien al hotel y dejarle los accesos justos: invitar vs. agregar, rol de empresa vs. apps del espacio, y el hueco que hay que tapar a mano. " +
      "Cargala cuando pidan dar de alta, invitar, sacar o cambiarle los permisos a alguien del equipo.",
    tags: ["usuarios", "permisos", "ajustes", "base"],
    body: [
      "# Alta y accesos del equipo",
      "",
      "## Dos ejes que no son lo mismo",
      "",
      "Confundirlos es el error clásico:",
      "",
      "- **Rol y capacidades de empresa** (`update_company_user_role`, `update_company_user_access`):",
      "  qué puede ADMINISTRAR en el hotel — usuarios, propiedades, ajustes, facturación, el builder.",
      "- **Apps del espacio operativo** (`add_space_user`, `update_space_user`): dónde puede OPERAR —",
      "  Recepción, Limpieza, Marketing, Revenue. Cada app con nivel `operate` o `write`.",
      "",
      "Alguien puede ser staff con acceso total a Recepción y no poder tocar Marketing. Es lo normal,",
      "no un error de configuración.",
      "",
      "## Invitar o agregar",
      "",
      "- **No tiene cuenta** → `invite_company_user`. Le llega un mail con el enlace de alta.",
      "- **Ya tiene cuenta en la plataforma** → `add_users_to_company` por email.",
      "",
      "Cuidado con el segundo: quien entra por ahí queda SIN acotar — ve todas las propiedades hasta",
      "que alguien le edite los accesos. Cuando lo uses, encadená `update_company_user_access` en el",
      "mismo pedido y decíselo al usuario. No lo dejes para después.",
      "",
      "## Nadie otorga lo que no tiene",
      "",
      "El PMS no deja conceder una capacidad que el que la otorga no tiene. Si te rebota, no es un",
      "bug ni hay que buscar otro camino: es que el usuario no puede dar eso. Explicalo así.",
      "",
      "## La secuencia recomendada",
      "",
      "1. `list_company_users` → ver si ya está y con qué rol.",
      "2. Invitar o agregar según el caso.",
      "3. `update_company_user_access` → acotar propiedades y capacidades.",
      "4. `list_operative_spaces` + `add_space_user` → dónde opera y con qué nivel por app.",
      "5. Contale al usuario, en una línea, qué va a poder hacer esa persona y qué no.",
      "",
      "## Sacar a alguien",
      "",
      "- Se va del hotel pero querés conservar su historial: `update_company_user_status` (inactivo).",
      "- Sacarlo de verdad: `remove_company_user`. Pide confirmación en tarjeta.",
      "- Sacarlo de un espacio sin sacarlo del hotel: `remove_space_user`.",
      "",
      "Preguntá cuál de las tres antes de elegir. Casi siempre quieren la primera.",
    ].join("\n"),
  },

  {
    name: "tarifas-promociones-y-disponibilidad",
    displayName: "Tarifas, promociones y disponibilidad",
    description:
      "El orden correcto para tocar precios y cupos sin romper el motor: qué es un plan tarifario, qué es una promo, qué es una restricción por día y qué mirar antes de mover nada. " +
      "Cargala cuando pidan cambiar precios, crear una promoción, cerrar fechas o abrir disponibilidad.",
    tags: ["tarifas", "promociones", "motor", "base"],
    body: [
      "# Tarifas, promociones y disponibilidad",
      "",
      "## Qué es cada cosa",
      "",
      "- **Plan tarifario** (`list_rate_plans`): el precio base de una categoría, con sus condiciones",
      "  (mínimo de noches, cancelación, régimen). Es la estructura.",
      "- **Promoción** (`list_promos`): un descuento sobre esos planes, con vigencia y condiciones.",
      "  Es temporal y se prende y apaga (`toggle_promo`) sin tocar la estructura.",
      "- **Restricción por día** (`get_day_restrictions`): cierre de venta, mínimo de noches o",
      "  llegada/salida cerrada en fechas puntuales. NO es precio.",
      "- **Disponibilidad** (`get_availability_calendar`): cuántas unidades quedan. No se edita a mano",
      "  para 'cerrar' una fecha: para eso está la restricción.",
      "",
      "Si el usuario dice 'subí el precio del fin de semana largo', casi nunca quiere tocar el plan",
      "base: quiere una promo negativa, una regla de revenue o una restricción. Preguntá qué prefiere",
      "antes de cambiar la estructura.",
      "",
      "## Antes de mover un precio",
      "",
      "1. `get_availability_calendar` en el rango → ¿está vendido o vacío? Cambia la recomendación.",
      "2. `list_rate_plans` → qué plan gobierna esas fechas y esa categoría.",
      "3. `list_promos` → si ya hay una promo activa que se va a apilar con lo que estás por hacer.",
      "",
      "Un precio nuevo sin mirar la ocupación es adivinar.",
      "",
      "## Para crear una promo",
      "",
      "Pedí lo que falte antes de crearla, no después: fechas de vigencia, a qué planes aplica, el",
      "descuento, y si tiene condiciones (mínimo de noches, anticipación, sólo directo). Después",
      "`create_promo` y confirmá mostrando el resumen.",
      "",
      "Las promos nacen apagadas o encendidas según cómo las crees: decí en qué estado quedó y cómo",
      "se prende con `toggle_promo`.",
      "",
      "## Cerrar fechas",
      "",
      "`update_day_restrictions` con el rango. No borres disponibilidad ni bloquees unidades para",
      "'cerrar la venta': los bloqueos de unidad (`create_unit_block`) son para mantenimiento o uso",
      "interno de una habitación concreta, y se ven distinto en el calendario del hotel.",
      "",
      "## Si el hotel tiene Revenue",
      "",
      "Cuando el pedido es de criterio ('¿a cuánto conviene vender?') y no de ejecución, las",
      "habilidades de revenue tienen el procedimiento. Acá quedate en lo operativo.",
    ].join("\n"),
  },

  {
    name: "permisos-y-espacio-operativo",
    displayName: "Permisos y espacio operativo",
    description:
      "Cómo explicar que el usuario no puede hacer algo sin sonar a error del sistema, y cómo trabajar dentro del alcance del espacio donde está parado. " +
      "Cargala cuando una herramienta rebote por permisos o el usuario pregunte por un área que no tiene.",
    tags: ["permisos", "espacios", "base"],
    body: [
      "# Permisos y espacio operativo",
      "",
      "## El usuario no ve toda la plataforma, y está bien",
      "",
      "Cada persona trabaja dentro de un espacio operativo (Recepción, Limpieza, Marketing, Revenue…)",
      "con un nivel por app, y tiene además capacidades de empresa. Vos operás con SUS permisos, no",
      "con los tuyos: lo que la persona no puede hacer en el PMS, no lo podés hacer vos por ella.",
      "",
      "Las herramientas que el usuario no puede usar ni siquiera te llegan. Si intentás una y rebota,",
      "el mensaje ya viene explicado.",
      "",
      "## Cómo decirlo",
      "",
      "Mal: 'No tengo esa función' / 'El sistema no lo permite' / 'Hubo un error'.",
      "Bien: 'Eso es del área de Marketing y tu usuario no tiene acceso a esa área. Te lo puede",
      "habilitar quien administre usuarios del hotel.'",
      "",
      "Tres reglas:",
      "",
      "1. Nombrá el área o el permiso concreto, con el nombre que el usuario ve en el menú.",
      "2. Decí quién se lo puede dar (un owner o admin del hotel, o quien tenga gestión de usuarios).",
      "3. No lo registres como funcionalidad faltante: la función existe, el permiso no.",
      "",
      "## No busques la vuelta",
      "",
      "Si una acción rebotó por permisos, no intentes el mismo cambio por otro endpoint, ni con la",
      "herramienta cruda, ni desde otra pantalla. Está cortado en el runtime a propósito y el único",
      "resultado de insistir es una conversación más larga con el mismo final.",
      "",
      "## Propiedad y espacio tienen que coincidir",
      "",
      "Si el usuario está parado en el espacio de una propiedad y te pide algo de otra, decilo: hay",
      "que cambiar de propiedad o de espacio primero (`set_active_operative_space`). Operar 'por",
      "afuera' no es un atajo, es una fuente de errores silenciosos.",
    ].join("\n"),
  },

  {
    name: "configurar-el-motor-de-reservas",
    displayName: "Configurar el motor de reservas",
    description:
      "Qué revisar cuando el motor no vende o vende mal: ajustes del motor, modelo de categorías y unidades, monedas y servicios extra. " +
      "Cargala cuando el pedido sea de configuración del motor, o cuando algo no aparezca en la web de reservas.",
    tags: ["motor", "configuracion", "base"],
    body: [
      "# Configurar el motor de reservas",
      "",
      "## 'No aparece nada para reservar'",
      "",
      "Casi siempre es una de cinco, en este orden:",
      "",
      "1. **No hay disponibilidad cargada** para el rango → `get_availability_calendar`.",
      "   Si está vacío, `initialize_availability`.",
      "2. **No hay plan tarifario** para esa categoría y fecha → `list_rate_plans`.",
      "3. **Hay una restricción** que cierra la venta → `get_day_restrictions`.",
      "4. **El modelo está inconsistente**: categorías sin unidades, unidades huérfanas →",
      "   `get_engine_model_audit`. Si propone correcciones, explicá cuáles antes de",
      "   `autocorrect_engine_model`.",
      "5. **El motor está apagado o mal configurado** → `get_engine_settings`.",
      "",
      "Recorré la lista antes de concluir que 'el hotel no tiene habitaciones'. Una propiedad recién",
      "creada tiene el inventario vacío, y eso no es una falla del sistema: es que falta cargarlo.",
      "",
      "## Categorías y unidades",
      "",
      "Una **categoría** es el tipo de habitación que se vende; una **unidad** es la habitación",
      "física. El motor vende categorías y asigna unidades.",
      "",
      "Si el hotel quiere vender habitaciones individualizadas (típico en cabañas, departamentos o",
      "casas), eso es un cambio de modelo, no un ajuste: `open_unit_migration` y el procedimiento de",
      "la habilidad de acciones irreversibles.",
      "",
      "## Monedas",
      "",
      "La moneda base es del hotel y se cambia con una migración, no editando precios. Lo que sí se",
      "ajusta sin drama son las monedas que el motor MUESTRA al huésped y el tipo de cambio",
      "(`get_engine_settings` / `update_engine_settings`, `preview_exchange_rates`).",
      "",
      "## Servicios extra",
      "",
      "`list_services` los lista; se vinculan a categorías con `link_service_to_room_category`. Un",
      "servicio sin vínculo no aparece en el flujo de reserva de esa categoría: es la causa más común",
      "de 'cargué el desayuno y no se ve'.",
    ].join("\n"),
  },

  {
    name: "ejecutar-en-vez-de-explicar",
    displayName: "Ejecutar en vez de explicar",
    description:
      "Cuándo hacer la tarea y cuándo contar cómo se hace. La regla por defecto es hacerla: el usuario tiene la plataforma entera a través tuyo. " +
      "Cargala si dudás entre guiar al usuario por el menú del PMS o resolverlo vos.",
    tags: ["criterio", "base"],
    body: [
      "# Ejecutar en vez de explicar",
      "",
      "## La regla",
      "",
      "Si el usuario puede hacerlo en el PMS y vos tenés la herramienta, HACELO. No le expliques el",
      "camino por el menú salvo que te lo pida o que la acción esté fuera de tu alcance.",
      "",
      "Mal: 'Podés crear la promoción desde Reservas → Promociones → Nueva.'",
      "Bien: crear la promoción, y después decir dónde quedó por si la quiere revisar.",
      "",
      "## Lo que falta, pedilo; lo que podés averiguar, averiguálo",
      "",
      "Antes de preguntar, fijate si ya lo podés resolver con una lectura. Si el hotel tiene una sola",
      "propiedad, no preguntes cuál. Si hay un solo sitio web, no preguntes cuál. Preguntá sólo lo",
      "que de verdad decide el usuario: fechas, importes, textos, a quién.",
      "",
      "Una pregunta por turno, no un cuestionario.",
      "",
      "## Encadená",
      "",
      "La mayoría de los pedidos reales son varias herramientas seguidas: leer para ubicarte, escribir,",
      "y leer de nuevo para confirmar el resultado. Hacé la cadena completa en el mismo turno; no",
      "devuelvas un paso intermedio como si fuera la respuesta.",
      "",
      "## Cerrá con el resultado real",
      "",
      "Decí qué quedó hecho, con el dato concreto que lo prueba (el código de la reserva, el nombre de",
      "la promo, cuántas páginas se publicaron). Si algo falló, decilo igual de claro y contá qué",
      "parte sí quedó hecha.",
      "",
      "Nunca anuncies un resultado que no viste. Si la herramienta devolvió `confirmation_required`,",
      "no pasó nada todavía.",
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
        changeNote: "seed inicial de habilidades base",
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
        changeNote: "actualizacion via seed:base-skills",
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
    `\n${SKILLS.length} habilidades base — ${created} creadas, ${updated} actualizadas, ${unchanged} sin cambios`,
  );

  // Declararlas en la versión del agente. Crear la habilidad no alcanza: la
  // lista `version.skills` es el SELECTOR que decide cuáles ve el agente, y el
  // nivel 1 (la línea en el prompt) se arma a partir de ahí. Se UNEN con las
  // que ya estaban declaradas para no pisar lo que sembró seed:revenue-skills.
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
    changeNote: `seed:base-skills — ${SKILLS.length} habilidades base declaradas`,
  });
  logPublishResult(published, "habilidades");

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("seed:base-skills error:", err);
  process.exit(1);
});

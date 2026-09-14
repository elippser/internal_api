/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests de los guardarraíles de Roombir IA. Sin DB, sin red, sin tokens.
 *
 * Dos cosas que, si se rompen, se rompen en silencio y caro:
 *
 *   1. `builderEditor` sólo puede reemplazar hojas que YA existen. Si un día
 *      alguien "arregla" resolveLeaf para que cree lo que falta, el agente pasa
 *      a poder inventar estructura en una página publicada.
 *   2. La confirmación dura tapa TODO borrado y TODA acción irreversible del
 *      catálogo. Una tool nueva marcada `isDestructive` con método DELETE
 *      —o `irreversible`— tiene que caer en la tarjeta sola, sin que nadie se
 *      acuerde de agregarla a una lista.
 *
 *   npm run test:guardrails
 */
import {
  flatten,
  mergeFixedProps,
  parseEdits,
  resolveLeaf,
  BUILDER_EDITOR_TOOLS,
} from "../modules/conversations/services/builderEditor";
import {
  ENGINE_DIAGNOSIS_TOOLS,
  describeEngineStudio,
} from "../modules/conversations/services/engineCalendarDiagnosis";
import {
  confirmationFor,
  typedAnswerMatches,
} from "../modules/conversations/services/confirmationPolicy";
import { INITIAL_TOOLS } from "../modules/tools/tools.model";
import { withUpstreamDetail } from "../modules/conversations/services/toolExecutor";

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  OK    ${name}`);
  } else {
    failed++;
    console.log(`  FALLA ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function throws(name: string, fn: () => unknown, match?: RegExp): void {
  try {
    fn();
    failed++;
    console.log(`  FALLA ${name} — no lanzó`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (match && !match.test(msg)) {
      failed++;
      console.log(`  FALLA ${name} — mensaje inesperado: ${msg}`);
    } else {
      console.log(`  OK    ${name}`);
    }
  }
}

// Página de prueba: dos secciones con textos, una imagen y una lista anidada.
const PAGE = [
  {
    name: "HeroBanner",
    type: "hero",
    priority: 0,
    props: {
      title: "Bienvenidos al hotel",
      subtitle: "",
      image: "https://res.cloudinary.com/x/hero.jpg",
      cta: { label: "Reservar", href: "https://reservas.example.com" },
      showOverlay: true,
    },
  },
  {
    name: "RoomsGrid",
    type: "grid",
    priority: 1,
    props: {
      heading: "Nuestras habitaciones",
      cards: [
        { title: "Suite", price: 120 },
        { title: "Doble", price: 80 },
      ],
    },
  },
];

console.log("\n=== builderEditor: lectura ===");
{
  const { leaves, truncated } = flatten(PAGE);
  const paths = leaves.map((l) => l.path);
  check("aplana hojas anidadas", paths.includes("1.props.cards.0.title"), paths.join(", "));
  check("ignora strings vacíos", !paths.includes("0.props.subtitle"));
  check("detecta imágenes", leaves.find((l) => l.path === "0.props.image")?.kind === "image");
  check("detecta enlaces", leaves.find((l) => l.path === "0.props.cta.href")?.kind === "url");
  check("incluye números", leaves.find((l) => l.path === "1.props.cards.0.price")?.kind === "number");
  check("no trunca una página chica", truncated === false);

  const solo = flatten(PAGE, { componentIndex: 1 });
  check("componentIndex acota a un componente", solo.leaves.every((l) => l.path.startsWith("1.")));

  const filtrado = flatten(PAGE, { contains: "habitaciones" });
  check(
    "contains filtra sin distinguir mayúsculas",
    filtrado.leaves.length === 1 && filtrado.leaves[0].path === "1.props.heading",
  );
}

console.log("\n=== builderEditor: la garantía (sólo reemplaza lo que existe) ===");
{
  const ok = resolveLeaf(PAGE, "0.props.title");
  check("resuelve una hoja existente", ok.parent[ok.key as any] === "Bienvenidos al hotel");

  throws(
    "rechaza un campo inventado",
    () => resolveLeaf(PAGE, "0.props.tituloNuevo"),
    /no existe/i,
  );
  throws(
    "rechaza un componente inexistente",
    () => resolveLeaf(PAGE, "9.props.title"),
    /no existe|se cortó/i,
  );
  throws(
    "rechaza apuntar a un objeto",
    () => resolveLeaf(PAGE, "0.props.cta"),
    /objeto/i,
  );
  throws(
    "rechaza apuntar a una lista",
    () => resolveLeaf(PAGE, "1.props.cards"),
    /lista/i,
  );
  throws("rechaza un path vacío", () => resolveLeaf(PAGE, ""), /inválido/i);
  throws("rechaza un path de un segmento", () => resolveLeaf(PAGE, "0"), /inválido/i);

  // La estructura no se tocó al resolver.
  check("resolver no muta el árbol", JSON.stringify(PAGE[0].props.cta) === '{"label":"Reservar","href":"https://reservas.example.com"}');
}

console.log("\n=== builderEditor: validación de ediciones ===");
{
  const parsed = parseEdits([{ path: "0.props.title", value: "Hola" }]);
  check("acepta una edición bien formada", parsed.length === 1 && parsed[0].value === "Hola");
  throws("rechaza lista vacía", () => parseEdits([]), /al menos un cambio/i);
  throws("rechaza que no sea lista", () => parseEdits({} as any), /lista/i);
  throws("rechaza valor nulo", () => parseEdits([{ path: "a.b", value: null }]), /texto, número o booleano/i);
  throws(
    "rechaza valor objeto",
    () => parseEdits([{ path: "a.b", value: { x: 1 } }]),
    /texto, número o booleano/i,
  );
  throws(
    "rechaza un lote gigante",
    () => parseEdits(Array.from({ length: 61 }, () => ({ path: "0.props.title", value: "x" }))),
    /Demasiados cambios/i,
  );
}

console.log("\n=== confirmación dura ===");
{
  const del = {
    name: "delete_gallery",
    execution: { method: "DELETE" },
    permissions: { isDestructive: true },
  };
  check("un DELETE destructivo pide tarjeta", confirmationFor(del as any, {}).level === "card");

  const patch = {
    name: "update_reservation_status",
    execution: { method: "PATCH" },
    permissions: { isDestructive: true },
  };
  check(
    "un PATCH no pide tarjeta aunque esté marcado destructivo",
    confirmationFor(patch as any, {}).level === "none",
  );

  const irreversible = {
    name: "reset_whole_site_content",
    execution: { method: "DELETE" },
    permissions: { isDestructive: true, irreversible: true, confirmSubject: "siteId" },
  };
  const req = confirmationFor(irreversible as any, { siteId: "site-42" });
  check("una irreversible pide confirmación escrita", req.level === "typed");
  check("toma el valor del argumento indicado", req.subjectValue === "site-42");
  check(
    "sin el argumento cae a ELIMINAR en vez de a 'undefined'",
    confirmationFor(irreversible as any, {}).subjectValue === "ELIMINAR",
  );

  // Tool cruda: el método lo elige el modelo en los argumentos.
  const raw = {
    name: "write_pms_core_api",
    category: "raw_write",
    execution: { method: "POST" },
    permissions: { isDestructive: true },
  };
  check(
    "la tool cruda con DELETE pide tarjeta",
    confirmationFor(raw as any, { method: "delete", path: "/x" }).level === "card",
  );
  check(
    "la tool cruda con PATCH no",
    confirmationFor(raw as any, { method: "PATCH", path: "/x" }).level === "none",
  );

  check("la comparación escrita ignora mayúsculas y espacios", typedAnswerMatches("site-42", " Site-42 "));
  check("la comparación escrita rechaza otra cosa", !typedAnswerMatches("site-42", "site-43"));
  check("la comparación escrita rechaza vacío", !typedAnswerMatches("site-42", ""));
}

console.log("\n=== errores del servicio: el motivo tiene que llegar al modelo ===");
{
  // Caso real del 12-09-2026: el modelo recibía sólo "respondio 400", reintentó
  // cuatro veces a ciegas y le dijo al usuario que el sistema lo rechazaba.
  const base = "Upstream booking-app respondio 400";
  check(
    "incluye `error` + `details` del cuerpo Joi",
    withUpstreamDetail(base, {
      error: "Validación fallida",
      details: ["checkInTime debe tener formato HH:mm"],
    }) === `${base}: Validación fallida · checkInTime debe tener formato HH:mm`,
  );
  check(
    "incluye un `error` simple",
    withUpstreamDetail(base, { error: "propertyId es requerido" }) === `${base}: propertyId es requerido`,
  );
  check(
    "acepta details como objetos { message }",
    withUpstreamDetail(base, { details: [{ message: "\"x\" is not allowed" }] }).endsWith('"x" is not allowed'),
  );
  check("un cuerpo string se usa tal cual", withUpstreamDetail(base, "boom") === `${base}: boom`);
  check("un HTML de error no ensucia el mensaje", withUpstreamDetail(base, "<!DOCTYPE html><html>…") === base);
  check("sin cuerpo queda el mensaje original", withUpstreamDetail(base, null) === base);
}

console.log("\n=== contrato de propertyId en escrituras que lo leen de la query ===");
{
  // booking-app/engineSettingsController lee propertyId de req.query en el PUT.
  // Sin `?propertyId={propertyId}` en el template, el ejecutor lo mete en el
  // body y el servicio responde 400 en TODA escritura (así estuvo hasta el
  // 12-09-2026). verify:tool-coverage lo detecta contra los controllers reales;
  // esto lo fija sin depender de tener los repos hermanos.
  const t = (INITIAL_TOOLS as any[]).find((x) => x.name === "update_engine_settings");
  check(
    "update_engine_settings manda propertyId por query",
    Boolean(t && /\?propertyId=\{propertyId\}/.test(t.execution.pathTemplate)),
    t?.execution.pathTemplate,
  );
  check(
    "update_engine_settings expone los horarios",
    Boolean(t?.inputSchema?.properties?.checkInTime && t?.inputSchema?.properties?.checkOutTime),
  );
}

console.log("\n=== cobertura del gate sobre el catálogo ===");
{
  const tools = INITIAL_TOOLS as any[];
  // Todo lo que borra de verdad tiene que caer en la tarjeta solo.
  const sinGate = tools.filter(
    (t) =>
      t.permissions?.isDestructive &&
      String(t.execution?.method).toUpperCase() === "DELETE" &&
      confirmationFor(t, {}).level === "none",
  );
  check(
    "ningún DELETE destructivo se escapa del gate",
    sinGate.length === 0,
    sinGate.map((t) => t.name).join(", "),
  );

  const irreversiblesSinSujeto = tools.filter(
    (t) => t.permissions?.irreversible && !t.permissions?.confirmSubject,
  );
  check(
    "toda irreversible declara confirmSubject",
    irreversiblesSinSujeto.length === 0,
    irreversiblesSinSujeto.map((t) => t.name).join(", "),
  );

  const sujetoInexistente = tools.filter((t) => {
    const subj = t.permissions?.confirmSubject;
    if (!subj) return false;
    const props = t.inputSchema?.properties ?? {};
    return !(subj in props);
  });
  check(
    "el confirmSubject existe en el inputSchema de su tool",
    sujetoInexistente.length === 0,
    sujetoInexistente.map((t) => `${t.name}.${t.permissions.confirmSubject}`).join(", "),
  );

  const typed = tools.filter((t) => confirmationFor(t, {}).level === "typed");
  const card = tools.filter((t) => confirmationFor(t, {}).level === "card");
  console.log(`  · ${typed.length} con confirmación escrita, ${card.length} con tarjeta simple`);

  // Las tools del builder que editan tienen que existir en el catálogo, o el
  // dispatch de executeTool apunta a nombres que nadie puede llamar.
  const nombres = new Set(tools.map((t) => t.name));
  const faltantes = [...BUILDER_EDITOR_TOOLS].filter((n) => !nombres.has(n));
  check(
    "las tools nativas del builder están en el catálogo",
    faltantes.length === 0,
    faltantes.join(", "),
  );

  const faltanDiagnostico = [...ENGINE_DIAGNOSIS_TOOLS].filter((n) => !nombres.has(n));
  check(
    "las tools nativas de diagnóstico del motor están en el catálogo",
    faltanDiagnostico.length === 0,
    faltanDiagnostico.join(", "),
  );
}

// "Arreglar todo" guarda lo que devuelve el lint del servidor. Tiene que valer
// lo mismo que para edit_page_content: nunca cambia la estructura de la página.
console.log("\n=== Arreglar todo (calidad del sitio): solo props de secciones existentes ===");
{
  const actual = [
    { name: "Hero", type: "hero", priority: 0, props: { title: "Hola", image: { alt: "" } } },
    { name: "Rooms", type: "grid", priority: 1, props: { items: [] } },
  ];
  const corregido = [
    { name: "OTRO", type: "otro", props: { title: "Hola", image: { alt: "Frente del hotel" } } },
    { props: { items: [] } },
  ];
  const merged = mergeFixedProps(actual, corregido);
  check("con cambios devuelve la lista corregida", Array.isArray(merged) && merged.length === 2);
  check(
    "de cada sección solo cambian los props (name/type/priority quedan)",
    !!merged && merged[0].name === "Hero" && merged[0].type === "hero" && merged[0].priority === 0 &&
      merged[0].props.image.alt === "Frente del hotel",
  );
  check("una sección sin cambios queda idéntica (misma referencia)", !!merged && merged[1] === actual[1]);
  check("sin cambios no escribe (null)", mergeFixedProps(actual, actual) === null);
  check(
    "si el servidor devuelve otra cantidad de secciones no escribe (null)",
    mergeFixedProps(actual, [...corregido, { props: {} }]) === null && mergeFixedProps(actual, corregido.slice(0, 1)) === null,
  );
  check("con algo que no es lista no escribe (null)", mergeFixedProps(actual, { page: [] }) === null);
}

// El 13-09-2026 el agente leyó el null del Estudio del Motor como "no pude leer
// la configuración". Sin personalizar tiene que decir que rigen los defaults.
console.log("\n=== Estudio del Motor sin personalizar ===");
{
  const vacio = describeEngineStudio(null);
  check("null = no configurado", vacio.configured === false);
  check("null = calendario informativo encendido por defecto", vacio.effective.calendar.enabled === true);
  check("la nota aclara que no es un error de lectura", /NO es un error/.test(vacio.note));
  const apagado = describeEngineStudio({ calendar: { enabled: false } });
  check("respeta un calendario apagado", apagado.configured && apagado.effective.calendar.enabled === false);
}

console.log(
  failed === 0 ? "\n=== RESULTADO: todo OK ===\n" : `\n=== RESULTADO: ${failed} fallas ===\n`,
);
process.exit(failed === 0 ? 0 : 1);

/**
 * Saneado de los JSON Schema de las tools antes de mandarlos a un proveedor.
 *
 * El problema, medido el 2026-09-11: Anthropic aceptaba `{"type":"array"}`
 * pelado, sin `items`. Google lo rechaza con
 *
 *   GenerateContentRequest.tools[0].function_declarations[87]
 *     .parameters.properties[order].items: missing field
 *
 * y —esto es lo que lo vuelve grave— se lleva puesto el **pedido entero**, no
 * la tool que falla: las declaraciones viajan todas juntas en el mismo request,
 * asi que UNA propiedad mal declarada entre doscientas cincuenta y seis apaga
 * el chat completo con un 400. Con Anthropic el defecto estuvo siempre ahi, sin
 * consecuencia visible; al cambiar de proveedor se cobro de golpe.
 *
 * Se probo contra Google que TODO lo demas pasa (`additionalProperties`, `enum`,
 * `oneOf`, `format`, `default`, `$schema`, nodos sin `type`): el unico requisito
 * extra es `items`, y rige a cualquier profundidad — dentro de otro array y
 * dentro de las propiedades de un objeto anidado.
 *
 * El relleno es `items: {}` a proposito. Un `{type:"string"}` seria adivinar:
 * varias de estas propiedades (`rates`, `photos`, `candidates`) son arrays de
 * objetos, y declararles el tipo equivocado hace que el modelo emita datos
 * equivocados con toda confianza. Un esquema vacio significa "cualquier cosa",
 * que es exactamente lo que el esquema original decia.
 *
* Esto es una RED, no el arreglo: lo correcto es que la definicion de la tool
 * declare bien sus items. `collectSchemaDefects` existe para encontrarlas
 * (`npm run audit:tool-schemas`).
 *
 * ── SEGUNDO DEFECTO, medido el 2026-09-12 ────────────────────────────────────
 *
 * `enum` sobre una propiedad NUMERICA: `{type:"number", enum:[30,60,90]}`.
 *
 * Anthropic lo aceptaba. Google NO da error: acepta el pedido, el modelo emite
 * su `tool_use` y los argumentos vienen **vacios** — `{}` — para TODA la tool,
 * no solo para esa propiedad.
 *
 * Es peor que el 400 del caso anterior, justamente porque no falla: no hay
 * nada que loguear, y desde afuera parece que el modelo decidio no completar
 * nada. Costo un turno real entenderlo, aislando la tool sola contra
 * gemini-3.8-flash hasta que sacar el enum hizo aparecer los cinco argumentos.
 *
 * Los enum de STRING andan bien y se conservan: son los que de verdad acotan al
 * modelo. El de numero se quita, y los valores validos se explican en la
 * `description`, que el modelo lee igual.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Devuelve una copia del esquema con todos los arrays completos. No muta la
 * entrada: los esquemas vienen de documentos de Mongo cacheados y de constantes
 * de modulo, y escribirles encima ensucia estructuras compartidas.
 */
export function normalizeToolSchema<T>(schema: T): T {
  return walk(schema, () => {}) as T;
}

/**
 * Lista legible de los defectos, con la ruta de cada uno. Para el auditor: dice
 * QUE arreglar en la definicion, en vez de taparlo en silencio.
 */
export function collectSchemaDefects(schema: unknown): string[] {
  const defects: string[] = [];
  walk(schema, (path, kind) =>
    defects.push(
      kind === "array"
        ? `${path || "(raiz)"}: array sin \`items\` (Google rechaza el pedido entero con 400)`
        : `${path || "(raiz)"}: \`enum\` numerico (Google devuelve los argumentos VACIOS, sin error)`,
    ),
  );
  return defects;
}

type DefectKind = "array" | "numeric-enum";

function walk(
  node: unknown,
  onDefect: (path: string, kind: DefectKind) => void,
  path = "",
): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => walk(item, onDefect, `${path}[${i}]`));
  }
  if (!isObject(node)) return node;

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    // `properties` y `$defs` tienen NOMBRES de usuario como claves, no palabras
    // de JSON Schema: una propiedad que se llame "items" o "type" no es la
    // palabra homonima. Se recorre igual, pero la ruta lo refleja.
    const childPath =
      key === "properties" || key === "$defs" || key === "definitions"
        ? path
        : path
          ? `${path}.${key}`
          : key;
    out[key] = walk(value, onDefect, childPath);
  }

  if (out.type === "array" && out.items === undefined) {
    onDefect(path, "array");
    out.items = {};
  }
  // Enum numerico: se quita. Los valores siguen estando en la descripcion, que
  // es lo unico que el modelo necesita para elegir bien.
  if (
    (out.type === "number" || out.type === "integer") &&
    Array.isArray(out.enum)
  ) {
    onDefect(path, "numeric-enum");
    delete out.enum;
  }
  return out;
}

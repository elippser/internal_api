/**
 * Conversor de HTML suelto a JSX.
 *
 * Lo usa la migración del sitio viejo (`mkt_pages.html`, que era HTML crudo en
 * Mongo) al repo Next, y sirve igual para pegar un bloque de HTML dentro de una
 * página desde el panel.
 *
 * Va con un tokenizador chico y no con regex sueltas: los `<svg>` del landing
 * traen atributos guionados (`stroke-width`), comentarios `<!-- -->` y tags
 * autocerrados mezclados, y resolver eso a fuerza de reemplazos deja JSX que no
 * compila. Lo que NO hace es reindentar: respeta el whitespace del original
 * para que el diff contra el HTML viejo siga siendo legible.
 */

/** Elementos que en HTML no llevan cierre y en JSX tienen que autocerrarse. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elementos cuyo contenido no es markup y no hay que tokenizar. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/**
 * Atributos que no se resuelven con la regla general de camelCase: o cambian de
 * nombre (`class`), o el DOM los escribe con mayúscula sin guión de por medio
 * (`tabindex` -> `tabIndex`).
 */
const ATTRIBUTE_NAMES: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  autoplay: "autoPlay",
  autofocus: "autoFocus",
  autocomplete: "autoComplete",
  contenteditable: "contentEditable",
  spellcheck: "spellCheck",
  crossorigin: "crossOrigin",
  srcset: "srcSet",
  srcdoc: "srcDoc",
  colspan: "colSpan",
  rowspan: "rowSpan",
  enctype: "encType",
  novalidate: "noValidate",
  formaction: "formAction",
  formnovalidate: "formNoValidate",
  datetime: "dateTime",
  usemap: "useMap",
  frameborder: "frameBorder",
  allowfullscreen: "allowFullScreen",
  playsinline: "playsInline",
  charset: "charSet",
  "http-equiv": "httpEquiv",
  "accept-charset": "acceptCharset",
  inputmode: "inputMode",
  itemprop: "itemProp",
  itemscope: "itemScope",
  itemtype: "itemType",
  // SVG: el navegador acepta el atributo en minúscula, JSX no.
  viewbox: "viewBox",
  preserveaspectratio: "preserveAspectRatio",
  gradientunits: "gradientUnits",
  gradienttransform: "gradientTransform",
  patternunits: "patternUnits",
  patterncontentunits: "patternContentUnits",
  clippathunits: "clipPathUnits",
  maskunits: "maskUnits",
  maskcontentunits: "maskContentUnits",
  spreadmethod: "spreadMethod",
  markerwidth: "markerWidth",
  markerheight: "markerHeight",
  markerunits: "markerUnits",
  refx: "refX",
  refy: "refY",
  textlength: "textLength",
  lengthadjust: "lengthAdjust",
  startoffset: "startOffset",
  baseprofile: "baseProfile",
};

interface Attr {
  name: string;
  /** `null` = atributo booleano sin valor (`disabled`). */
  value: string | null;
}

interface TagToken {
  kind: "open" | "close";
  name: string;
  attrs: Attr[];
  selfClosing: boolean;
}

export interface HtmlToJsxResult {
  /** Markup listo para pegar dentro de un `return (...)`. */
  jsx: string;
  /** `<script src="...">` encontrados, en orden. Se sacan del markup. */
  externalScripts: string[];
  /** Contenido de los `<script>` inline. Se sacan del markup. */
  inlineScripts: string[];
  /** Contenido de los `<style>`. Se sacan del markup. */
  inlineStyles: string[];
}

export function htmlToJsx(html: string): HtmlToJsxResult {
  const out: string[] = [];
  const externalScripts: string[] = [];
  const inlineScripts: string[] = [];
  const inlineStyles: string[] = [];

  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf("<", i);

    if (lt === -1) {
      out.push(escapeJsxText(html.slice(i)));
      break;
    }

    if (lt > i) out.push(escapeJsxText(html.slice(i, lt)));

    // Comentario
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const body = html.slice(lt + 4, end === -1 ? len : end);
      out.push("{/*" + sanitizeComment(body) + "*/}");
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Doctype y demás declaraciones: no existen dentro de un componente.
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const tag = parseTag(html, lt);
    if (!tag) {
      // Un `<` suelto que no abre tag es texto.
      out.push(escapeJsxText("<"));
      i = lt + 1;
      continue;
    }

    if (tag.token.kind === "close") {
      out.push("</" + tag.token.name + ">");
      i = tag.end;
      continue;
    }

    const { name, attrs, selfClosing } = tag.token;

    // script y style salen del markup: en Next van como <Script> o como CSS
    // importado, no como un tag más del árbol.
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const { content, end } = readRawText(html, tag.end, name, selfClosing);
      const src = attrs.find((a) => a.name.toLowerCase() === "src")?.value;
      if (name === "script") {
        if (src) externalScripts.push(src);
        else if (content.trim()) inlineScripts.push(content);
      } else if (content.trim()) {
        inlineStyles.push(content);
      }
      i = end;
      continue;
    }

    const rendered = attrs.map(renderAttr).filter(Boolean).join(" ");
    const gap = rendered ? " " : "";
    if (selfClosing || VOID_ELEMENTS.has(name)) {
      out.push("<" + name + gap + rendered + " />");
    } else {
      out.push("<" + name + gap + rendered + ">");
    }
    i = tag.end;
  }

  return {
    jsx: out.join("").trim(),
    externalScripts,
    inlineScripts,
    inlineStyles,
  };
}

// ---------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------

function parseTag(
  html: string,
  start: number,
): { token: TagToken; end: number } | null {
  let i = start + 1;
  const kind: "open" | "close" = html[i] === "/" ? "close" : "open";
  if (kind === "close") i++;

  const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i += name.length;

  const attrs: Attr[] = [];
  let selfClosing = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) break;

    if (html[i] === ">") {
      i++;
      break;
    }
    if (html[i] === "/" && html[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      break;
    }

    const attrName = /^[^\s=/>]+/.exec(html.slice(i));
    if (!attrName) {
      i++;
      continue;
    }
    i += attrName[0].length;

    while (i < html.length && /\s/.test(html[i])) i++;

    let value: string | null = null;
    if (html[i] === "=") {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        value = html.slice(i + 1, end === -1 ? html.length : end);
        i = end === -1 ? html.length : end + 1;
      } else {
        const unquoted = /^[^\s>]*/.exec(html.slice(i))!;
        value = unquoted[0];
        i += unquoted[0].length;
      }
    }

    attrs.push({ name: attrName[0], value });
  }

  return { token: { kind, name, attrs, selfClosing }, end: i };
}

/** Lee el cuerpo crudo de un `<script>` / `<style>` hasta su cierre. */
function readRawText(
  html: string,
  from: number,
  name: string,
  selfClosing: boolean,
): { content: string; end: number } {
  if (selfClosing) return { content: "", end: from };
  const closeTag = "</" + name;
  const idx = html.toLowerCase().indexOf(closeTag, from);
  if (idx === -1) return { content: html.slice(from), end: html.length };
  const gt = html.indexOf(">", idx);
  return {
    content: html.slice(from, idx),
    end: gt === -1 ? html.length : gt + 1,
  };
}

// ---------------------------------------------------------------------------
// Atributos
// ---------------------------------------------------------------------------

function renderAttr(attr: Attr): string {
  const lower = attr.name.toLowerCase();

  // `data-` y `aria-` se escriben igual en JSX: camelCasearlos los rompe.
  const isPassthrough = lower.startsWith("data-") || lower.startsWith("aria-");
  const name = isPassthrough
    ? lower
    : (ATTRIBUTE_NAMES[lower] ?? camelCase(attr.name));

  if (attr.value === null) return name;

  if (name === "style") return "style={{" + styleToObject(attr.value) + "}}";

  return name + "=" + jsxAttrValue(attr.value);
}

function camelCase(name: string): string {
  if (!/[-:]/.test(name)) return name;
  const parts = name.split(/[-:]/);
  return (
    parts[0].toLowerCase() +
    parts
      .slice(1)
      .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ""))
      .join("")
  );
}

/**
 * Un valor con comillas dobles adentro no entra en `attr="..."`. En ese caso va
 * como expresión con comillas simples, y si además tiene simples, con backticks.
 */
function jsxAttrValue(value: string): string {
  if (!value.includes('"')) return '"' + value + '"';
  if (!value.includes("'")) return "{'" + value + "'}";
  const escaped = value.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return "{`" + escaped + "`}";
}

function styleToObject(css: string): string {
  const entries: string[] = [];
  for (const decl of splitDeclarations(css)) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (!prop || !value) continue;
    // Las custom properties conservan el nombre y van con la clave entre
    // comillas: `--brand` no es un identificador válido.
    const key = prop.startsWith("--") ? '"' + prop + '"' : camelCase(prop);
    entries.push(key + ": " + quoteStyleValue(value));
  }
  return entries.length ? " " + entries.join(", ") + " " : "";
}

/** Corta por `;` sin partir adentro de `url(...)` ni de comillas. */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

function quoteStyleValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return '"' + escaped + '"';
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/**
 * En el texto de un JSX las llaves abren una expresión y `<` abre un tag; los
 * dos hay que sacarlos del flujo. El `>` suelto sí es texto válido y se deja
 * como está, igual que las entidades HTML (`&nbsp;`, `&rarr;`), que JSX resuelve
 * igual que el navegador.
 */
function escapeJsxText(text: string): string {
  if (!/[{}<]/.test(text)) return text;
  return text.replace(/[{}<]/g, (ch) => '{"' + ch + '"}');
}

/**
 * Un cierre de comentario de bloque adentro del texto cortaría el
 * `{` + `/*` ... que envuelve al comentario antes de tiempo.
 */
function sanitizeComment(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

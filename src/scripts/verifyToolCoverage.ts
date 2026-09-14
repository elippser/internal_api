/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Verifica que Roombir IA llegue a TODA la plataforma.
 *
 * Enumera los routers reales de los microservicios del PMS y cruza cada
 * endpoint contra dos tablas del runtime del agente:
 *
 *   1) el catálogo de tools (`modules/tools/tools.model.ts`) — ¿hay una tool
 *      dedicada que pegue a ese method+path?
 *   2) la política de acceso (`shared/agentAuth/routePolicy.ts`) — ¿hay una
 *      regla que lo reconozca? Sin regla, la escritura es `unknown_write` y
 *      SOLO la puede hacer un owner/admin: el staff se queda afuera sin que
 *      nada falle ni loguee.
 *
 * Un endpoint que no está en ninguna de las dos y tampoco figura en `EXCLUDED`
 * es un hueco: el agente no puede hacer algo que la app sí hace. Sale con
 * código 1 para que se note.
 *
 * Por qué existe: el catálogo y la política se escriben a mano y se desfasan en
 * silencio. Cuando pms-core suma una ruta, nadie se entera hasta que un
 * hotelero le pide algo al chat y el agente contesta que "no está disponible".
 *
 *   npm run verify:tool-coverage           # resumen + huecos
 *   npm run verify:tool-coverage -- --all  # además lista lo ya cubierto
 *
 * Lee los repos hermanos desde el checkout local (no es un monorepo). Si no
 * están, avisa y sale 0: en CI del propio internal-roombir no hay nada que
 * verificar.
 */
import fs from "fs";
import path from "path";

import { INITIAL_TOOLS } from "../modules/tools/tools.model";
import {
  findRouteRule,
  normalizePath,
  type HttpMethod,
  type PolicyService,
} from "../shared/agentAuth/routePolicy";
import {
  MOUNTS,
  REPO_ROOT,
  SERVICES,
  familyKey,
  loadRouteInventory,
  type Endpoint,
} from "./lib/pmsRouteInventory";

/**
 * Endpoints que el agente NO debe cubrir con una tool dedicada, con el motivo.
 * Son cuatro familias: el flujo del huésped (no es el usuario del chat), lo
 * público (no necesita tool propia: se lee con las lecturas crudas, ver
 * `checkPublicReadsDocumented`), la autenticación (nunca vía agente) y lo
 * server-to-server (lo llaman los servicios entre sí con secret interno).
 *
 * Es una lista de patrones sobre `<servicio> <METHOD> <path>`; un endpoint
 * nuevo que caiga acá tiene que entrar a propósito, no por olvido.
 */
const EXCLUDED: Array<{ re: RegExp; why: string }> = [
  { re: /^\S+ \S+ \/api\/v1\/public\//, why: "endpoint público" },
  { re: /^pms-core \S+ \/site-data\/(first-available|get-site-for-client|client-data-pages|subsite\/:subSiteId$|custom-hostname\/resolve)/, why: "render público del sitio" },
  { re: /^booking-app \S+ \/api\/v1\/(availability\/public-calendar|engine-settings\/public)/, why: "endpoint público del motor" },
  { re: /^booking-app \S+ \/api\/v1\/motor\//, why: "flujo del huésped" },
  { re: /^\S+ \S+ \/internal\//, why: "server-to-server (secret interno)" },
  { re: /^\S+ \S+ \/api\/v1\/internal\//, why: "server-to-server (secret interno)" },
  { re: /^pms-core \S+ \/api\/v1\/access\/blocks/, why: "lo administra internal-roombir con secret interno" },
  { re: /^pms-core \S+ \/api\/v1\/access\/(session-started|events\/:eventId\/geo)/, why: "telemetría que emite el front" },
  { re: /^pms-core \S+ \/api\/v1\/induction\/(hub|space|app)-/, why: "telemetría de avance que emite el front" },
  { re: /^pms-core \S+ \/api\/v1\/invite\//, why: "alta por invitación (sin sesión)" },
  { re: /^pms-core \S+ \/api\/v1\/notifications\/(auth|ingest|debug-ping)/, why: "transporte de notificaciones" },
  { re: /^pms-core \S+ \/api\/v1\/ai\//, why: "IA del alta (otro agente)" },
  { re: /^pms-core \S+ \/(user\/(login|register|auth0)|reset-password\/)/, why: "autenticación" },
  { re: /^pms-core POST \/user\/change-password/, why: "la contraseña la cambia la persona, nunca el agente" },
  { re: /^pms-core POST \/company\/create/, why: "alta de empresa: va por invitación, fuera del PMS" },
  { re: /^pms-core \S+ \/site-data\/test\//, why: "endpoint de prueba" },
  { re: /^pms-core (POST|PUT|DELETE) \/api\/v1\/site-templates/, why: "plantillas de plataforma (las administra Roombir, no el hotelero)" },
  { re: /^\S+ GET \/(health|healthz|status)$/, why: "health check" },

  // ── StayPass: la cuenta del HUÉSPED ──────────────────────────────────────
  { re: /^staypass \S+ \/api\/v1\/(auth|guest)\//, why: "cuenta StayPass del huésped (login, perfil, contraseña): la maneja el huésped" },
  { re: /^staypass GET \/api\/v1\/reservations\/confirm$/, why: "link de confirmación que el huésped abre desde su email" },

  // ── Duplicados: la misma acción ya está cubierta por otra ruta ────────────
  { re: /^pms-core PUT \/company$/, why: "duplicado de PUT /company/:companyId (update_company)" },
  { re: /^pms-core PUT \/company\/language$/, why: "duplicado de PUT /company/:companyId/language (set_company_language)" },
  {
    re: /^pms-core \S+ \/api\/v1\/properties\/:propertyId\/units/,
    why: "mismo recurso que rooms-app (misma colección `units`): el agente opera habitaciones con list_units/create_unit/update_unit/change_room_status",
  },
  {
    re: /^pms-core \S+ \/api\/v1\/properties\/:propertyId\/(reservations|reports)/,
    why: "proxy de booking-app: el agente usa las tools de reservas e informes del motor",
  },

  // ── Escrituras que reciben el ÁRBOL ENTERO de componentes ────────────────
  // No se exponen a propósito: pedirle al modelo que reproduzca cientos de KB
  // de JSON sin perder una clave es la forma segura de vaciar una página. El
  // agente edita con las tools quirúrgicas de `builderEditor.ts`, que hacen
  // read-modify-write acá dentro y sólo tocan hojas existentes.
  {
    re: /^pms-core PUT \/site-data\/update\/:subSiteId\/to-page/,
    why: "reemplaza el árbol completo de la página: el agente edita con edit_page_content / move_page_component / remove_page_component",
  },
  {
    re: /^pms-core PUT \/site-data\/update-global\/(top|bottom)-global/,
    why: "reemplaza el árbol completo del encabezado/pie: el agente edita con edit_site_global_content",
  },
  {
    re: /^pms-core PUT \/site-data\/set-template-in-newsite/,
    why: "aplicar una plantilla exige el árbol de componentes de la plantilla: se hace desde el builder",
  },
];

// ── Cobertura de tools ───────────────────────────────────────────────────────

function buildToolIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const t of INITIAL_TOOLS as any[]) {
    const exec = t.execution;
    if (!exec?.pathTemplate || exec.pathTemplate === "{path}") continue;
    const key = familyKey(exec.targetService, exec.method, exec.pathTemplate);
    const list = index.get(key);
    if (list) list.push(t.name);
    else index.set(key, [t.name]);
  }
  return index;
}

// ── Lecturas públicas: el agente tiene que poder ver lo que ve el huésped ────
//
// Los GET públicos no llevan tool dedicada, pero el agente los necesita para
// DIAGNOSTICAR la web del hotel. El 13-09-2026 un hotelero preguntó por qué no
// podía elegir noviembre en su web; el endpoint que alimenta ese calendario
// (/api/v1/availability/public-calendar) no figuraba en ninguna descripción, el
// modelo no sabía que existía y terminó adivinando. Una lectura cruda que el
// modelo no conoce no sirve: cada GET público excluido tiene que aparecer,
// escrito tal cual (`:param` → `<param>`), en la descripción de la lectura
// cruda de su servicio.

const RAW_READ_TOOL: Partial<Record<PolicyService, string>> = {
  "pms-core": "read_pms_core_api",
  "booking-app": "read_booking_api",
  "rooms-app": "read_rooms_api",
  "rms-app": "read_rms_api",
};
const PUBLIC_READ_REASONS = new Set(["endpoint público", "endpoint público del motor"]);

function checkPublicReadsDocumented(excluded: Array<Endpoint & { why: string }>): string[] {
  const issues: string[] = [];
  for (const e of excluded) {
    if (e.method !== "GET" || !PUBLIC_READ_REASONS.has(e.why)) continue;
    const toolName = RAW_READ_TOOL[e.svc];
    const tool = (INITIAL_TOOLS as any[]).find((t) => t.name === toolName);
    const spelled = e.path.replace(/:([A-Za-z_]\w*)/g, "<$1>");
    if (!tool) {
      issues.push(`${e.svc} GET ${spelled}: el servicio no tiene lectura cruda (${toolName ?? "ninguna"}).`);
    } else if (!String(tool.description ?? "").includes(spelled)) {
      issues.push(`${e.svc} GET ${spelled}: no figura en la descripción de ${toolName}.`);
    }
  }
  return issues;
}

// ── Contrato de propertyId en las escrituras de booking-app ──────────────────
//
// Cobertura no alcanza: una tool puede existir, pegarle a la ruta correcta y
// fallar en TODA llamada. Pasó con `update_engine_settings` (12-09-2026): el
// controller lee propertyId de `req.query`, pero executeTool en las escrituras
// lo pone en el BODY. Resultado: 400 "propertyId es requerido" siempre, y el
// agente contestándole a un hotelero que "el sistema rechazó el cambio".
//
// Se chequea en booking-app porque es el único servicio que mezcla las tres
// convenciones (query, body vía schema Joi, path). pms-core y rooms-app lo
// llevan en el path; rms-app siempre en la query y sus tools ya lo reflejan.

type PidPlace = "query" | "path" | "body" | "none";

function sliceConst(src: string, name: string): string | null {
  const m = new RegExp(`(?:export\\s+)?const ${name}\\s*=`).exec(src);
  if (!m) return null;
  const rest = src.slice(m.index);
  const next = rest.slice(10).search(/\n(?:export\s+)?const /);
  return next >= 0 ? rest.slice(0, next + 10) : rest;
}

/** "required" | "optional" | null, siguiendo `Joi.object(base)`, `.keys()` y spreads. */
function schemaPropertyId(valSrc: string, name: string, depth = 0): "required" | "optional" | null {
  const body = sliceConst(valSrc, name);
  if (!body) return null;
  const own = body.match(/\bpropertyId\s*:\s*Joi[^\n]*/);
  if (own) return /required\(\)/.test(own[0]) ? "required" : "optional";
  if (depth >= 3) return null;
  const refs = [
    ...body.matchAll(/Joi\.object\(\s*([A-Za-z_]\w*)\s*\)/g),
    ...body.matchAll(/([A-Za-z_]\w*)\.(?:keys|append|concat)\(/g),
    ...body.matchAll(/\.\.\.([A-Za-z_]\w*)/g),
  ].map((x) => x[1]);
  for (const r of refs) {
    if (r === name) continue;
    const found = schemaPropertyId(valSrc, r, depth + 1);
    if (found) return found;
  }
  return null;
}

/** `a.b(x.c()).d()` → `a.b().d()`: descarta lo que va dentro de paréntesis. */
function topLevelChain(s: string): string {
  let out = "";
  let d = 0;
  for (const ch of s) {
    if (ch === "(") {
      if (d === 0) out += "(";
      d++;
    } else if (ch === ")") {
      d--;
      if (d === 0) out += ")";
    } else if (d === 0) {
      out += ch;
    }
  }
  return out;
}

/**
 * Claves de PRIMER nivel de un schema Joi (→ ¿required?), siguiendo
 * `Joi.object(base)` y spreads. Se recorre el literal por profundidad de
 * llaves: las claves de objetos anidados no cuentan.
 */
function schemaTopKeys(valSrc: string, name: string, depth = 0): Map<string, boolean> | null {
  const raw = sliceConst(valSrc, name);
  if (!raw) return null;
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const eq = body.indexOf("=");
  const open = body.indexOf("{", eq);
  const head = body.slice(eq, open >= 0 ? open : undefined);
  const ref = head.match(/Joi\.object\(\s*([A-Za-z_]\w*)\s*\)/);
  if (ref) return depth < 3 ? schemaTopKeys(valSrc, ref[1], depth + 1) : null;
  if (open < 0) return null;

  const out = new Map<string, boolean>();
  const takeSegment = (seg: string) => {
    const s = seg.trim();
    const spread = s.match(/^\.\.\.([A-Za-z_]\w*)/);
    if (spread) {
      if (depth < 3) schemaTopKeys(valSrc, spread[1], depth + 1)?.forEach((v, k) => out.set(k, v));
      return;
    }
    const kv = s.match(/^["']?([A-Za-z_]\w*)["']?\s*:/);
    // Solo la cadena de primer nivel: en `Joi.array().items(Joi.string().required())`
    // el required es del ÍTEM, no del campo.
    if (kv) out.set(kv[1], /\.required\(\)/.test(topLevelChain(s)));
  };
  let d = 0;
  let quote: string | null = null;
  let segStart = open + 1;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      d--;
      if (d === 0) {
        takeSegment(body.slice(segStart, i));
        break;
      }
    } else if (ch === "," && d === 1) {
      takeSegment(body.slice(segStart, i));
      segStart = i + 1;
    }
  }
  return out;
}

function readTsDir(dir: string): string {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

function checkBookingPropertyIdContracts(): string[] {
  const root = path.join(REPO_ROOT, "booking-app/api/src");
  if (!fs.existsSync(root)) return [];
  const ctrlSrc = readTsDir(path.join(root, "controllers"));
  const valSrc = readTsDir(path.join(root, "validations"));
  const tools = (INITIAL_TOOLS as any[]).filter(
    (t) => t.execution?.targetService === "booking-app" && t.execution.pathTemplate !== "{path}",
  );
  const issues: string[] = [];

  for (const [file, prefix] of Object.entries(MOUNTS["booking-app"])) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, "routes", file), "utf8");
    } catch {
      continue;
    }
    const re = /\b\w*[Rr]outer\s*\.\s*(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]*)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const [, verb, routePath] = m;
      // Argumentos de ESTA llamada con paréntesis balanceados. Cortar en el
      // primer ")" agarraba el de `requireSpaceAccess("configuracion", "write")`:
      // el "handler" pasaba a llamarse `write`, no se encontraba su código y
      // TODA ruta con middleware salía como contrato roto — falsos positivos
      // que además tapaban el caso real.
      const open = src.indexOf("(", m.index);
      let depth = 0;
      let end = -1;
      let quote: string | null = null;
      for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
          if (ch === quote && src[i - 1] !== "\\") quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end < 0) continue;
      // Sin literales: "configuracion" / "write" no son identificadores.
      const args = src.slice(open + 1, end).replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "");
      const ids = args.match(/[A-Za-z_]\w*/g) ?? [];
      const handler = ids[ids.length - 1];
      if (!handler) continue;
      const body = sliceConst(ctrlSrc, handler);
      if (!body) {
        if (verb !== "get") {
          issues.push(`${verb.toUpperCase()} ${normalizePath(prefix + routePath)}: no encontré el handler "${handler}" en los controllers — no se puede verificar el contrato.`);
        }
        continue;
      }

      const method = verb.toUpperCase() as HttpMethod;
      const full = normalizePath(prefix + routePath);
      const readsQuery =
        /\{[^}]*\bpropertyId\b[^}]*\}\s*=\s*req\.query/.test(body) ||
        /req\.query(?:\.propertyId|\[\s*["']propertyId["']\s*\])/.test(body);
      const schemaName = (body.match(/(\w+Schema)\.validate\(\s*req\.body/) ?? [])[1];
      const schemaPid = schemaName ? schemaPropertyId(valSrc, schemaName) : null;
      const readsBody = /req\.body(?:\.propertyId|\[\s*["']propertyId["']\s*\])/.test(body);

      const tool = tools.find(
        (t) => familyKey("booking-app", t.execution.method, t.execution.pathTemplate) === familyKey("booking-app", method, full),
      );
      if (!tool) continue; // la cobertura la reporta la otra sección

      const tpl = String(tool.execution.pathTemplate);
      const gives: PidPlace = /\?[^#]*\bpropertyId=\{propertyId\}/.test(tpl)
        ? "query"
        : /\{propertyId\}/.test(tpl)
          ? "path"
          : tool.inputSchema?.properties?.propertyId
            ? "body"
            : "none";

      const where = `${method} ${full} → ${tool.name} (handler ${handler})`;

      // Lecturas: el ejecutor agrega ?propertyId= a TODA lectura salvo
      // `injectPropertyId: false`. Si el Joi de la query no lo admite, la tool
      // responde 400 siempre (search_guest_by_email, 13-09-2026).
      if (method === "GET") {
        const querySchema = (body.match(/(\w+Schema)\.validate\(\s*req\.query/) ?? [])[1];
        if (!querySchema) continue;
        const allowsUnknown = /\.unknown\(\s*(true)?\s*\)/.test(sliceConst(valSrc, querySchema) ?? "");
        const injects = tool.execution.injectPropertyId !== false && !/\{propertyId\}/.test(tpl);
        if (injects && !allowsUnknown && !schemaPropertyId(valSrc, querySchema)) {
          issues.push(`${where}: el ejecutor agrega propertyId a la QUERY y ${querySchema} no lo admite — Joi strict responde 400. Poné execution.injectPropertyId: false.`);
        }
        continue;
      }

      if (readsQuery && gives !== "query") {
        issues.push(`${where}: el handler lee propertyId de la QUERY y la tool lo manda por ${gives}. Poné "?propertyId={propertyId}" en el pathTemplate.`);
      } else if (gives === "body" && !schemaPid && !readsBody && !readsQuery) {
        issues.push(`${where}: la tool mete propertyId en el BODY y ${schemaName ?? "el handler"} no lo admite — Joi strict responde 400.`);
      } else if (schemaPid === "required" && gives === "none") {
        issues.push(`${where}: ${schemaName} exige propertyId en el body y la tool no lo declara — respondería 400 siempre.`);
      }

      // Claves del body: el modelo solo manda lo que la tool declara. Un campo
      // requerido que no está en el inputSchema = 400 en TODA llamada
      // (toggle_promo sin isEnabled, 13-09-2026); uno declarado que el Joi
      // strict no admite = 400 cada vez que el modelo lo usa.
      const keys = schemaName ? schemaTopKeys(valSrc, schemaName) : null;
      if (keys && keys.size) {
        const declared = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
        const inPath = new Set([...tpl.matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
        const missing = [...keys]
          .filter(([k, required]) => required && k !== "propertyId" && !declared.has(k) && !inPath.has(k))
          .map(([k]) => k);
        if (missing.length) {
          issues.push(`${where}: ${schemaName} exige ${missing.join(", ")} en el body y la tool no lo declara — responde 400 en TODA llamada.`);
        }
        const lenient =
          /\.unknown\(/.test(sliceConst(valSrc, schemaName) ?? "") || /allowUnknown\s*:\s*true|stripUnknown/.test(body);
        if (!lenient) {
          const unknown = [...declared].filter((k) => k !== "propertyId" && !keys.has(k) && !inPath.has(k));
          if (unknown.length) {
            issues.push(`${where}: la tool declara ${unknown.join(", ")} y ${schemaName} no lo admite — Joi strict responde 400 cuando el modelo lo manda.`);
          }
        }
      }
    }
  }
  return issues;
}

// ── Reporte ──────────────────────────────────────────────────────────────────

function excludedReason(key: string): string | null {
  for (const { re, why } of EXCLUDED) if (re.test(key)) return why;
  return null;
}

function main(): void {
  const showAll = process.argv.includes("--all");

  const inventory = loadRouteInventory();
  if (inventory.missing.length === SERVICES.length) {
    console.log(
      `⚠ No se encontraron los repos del PMS bajo ${REPO_ROOT}. ` +
        `Definí PMS_REPOS_ROOT para verificar la cobertura. Nada que hacer.`,
    );
    process.exit(0);
  }
  for (const svc of inventory.missing) {
    console.log(`⚠ ${svc}: no está en el checkout — se saltea`);
  }

  const toolIndex = buildToolIndex();
  const unique = inventory.endpoints;

  const noTool: Endpoint[] = [];
  const noRule: Endpoint[] = [];
  const excluded: Array<Endpoint & { why: string }> = [];
  const covered: Array<Endpoint & { tools: string[] }> = [];

  for (const ep of unique) {
    const key = `${ep.svc} ${ep.method} ${ep.path}`;
    const why = excludedReason(key);
    if (why) {
      excluded.push({ ...ep, why });
      continue;
    }
    const tools = toolIndex.get(familyKey(ep.svc, ep.method, ep.path));
    if (tools) covered.push({ ...ep, tools });
    else noTool.push(ep);
    if (!findRouteRule(ep.svc, ep.method, ep.path)) noRule.push(ep);
  }

  const line = (e: Endpoint) =>
    `  ${e.svc.padEnd(12)} ${e.method.padEnd(6)} ${e.path}`;

  console.log(
    `\n${unique.length} endpoints · ${covered.length} con tool · ` +
      `${noTool.length} sin tool · ${excluded.length} excluidos a propósito\n`,
  );

  if (inventory.unmounted.length) {
    console.log("⚠ Routers sin prefijo de montaje conocido (agregalos a MOUNTS en scripts/lib/pmsRouteInventory.ts):");
    for (const f of [...new Set(inventory.unmounted)]) console.log(`  ${f}`);
    console.log("");
  }

  if (noTool.length) {
    console.log(`✗ SIN TOOL DEDICADA (${noTool.length}) — el agente no llega:`);
    for (const e of noTool) console.log(line(e));
    console.log("");
  }

  if (noRule.length) {
    const writes = noRule.filter((e) => e.method !== "GET");
    console.log(
      `✗ SIN REGLA EN routePolicy (${noRule.length}; ${writes.length} escrituras) — ` +
        `las escrituras sólo las puede hacer owner/admin:`,
    );
    for (const e of noRule) console.log(line(e));
    console.log("");
  }

  if (showAll) {
    console.log(`✓ CUBIERTOS (${covered.length}):`);
    for (const e of covered) console.log(`${line(e)}  → ${e.tools.join(", ")}`);
    console.log(`\n· EXCLUIDOS (${excluded.length}):`);
    for (const e of excluded) console.log(`${line(e)}  — ${e.why}`);
    console.log("");
  }

  // Tools que apuntan a un endpoint que ya no existe: el otro lado del desfase.
  const endpointKeys = new Set(
    unique.map((e) => familyKey(e.svc, e.method, e.path)),
  );
  const stale = (INITIAL_TOOLS as any[]).filter((t) => {
    const exec = t.execution;
    if (!exec?.pathTemplate || exec.pathTemplate === "{path}") return false;
    if (inventory.missing.includes(exec.targetService)) return false; // repo ausente
    if (exec.pathTemplate.startsWith("/ui/")) return false; // acción de cliente
    return !endpointKeys.has(
      familyKey(exec.targetService, exec.method, exec.pathTemplate),
    );
  });
  if (stale.length) {
    console.log(`✗ TOOLS HUÉRFANAS (${stale.length}) — apuntan a rutas que no existen:`);
    for (const t of stale) {
      console.log(
        `  ${t.name.padEnd(38)} ${t.execution.targetService} ${t.execution.method} ${t.execution.pathTemplate}`,
      );
    }
    console.log("");
  }

  const publicIssues = checkPublicReadsDocumented(excluded);
  if (publicIssues.length) {
    console.log(
      `✗ LECTURAS PÚBLICAS QUE EL AGENTE NO CONOCE (${publicIssues.length}) — no puede ver lo que ve el huésped:`,
    );
    for (const i of publicIssues) console.log(`  ${i}`);
    console.log("");
  }

  const contractIssues = checkBookingPropertyIdContracts();
  if (contractIssues.length) {
    console.log(
      `✗ CONTRATO DE propertyId ROTO (${contractIssues.length}) — la tool existe pero falla en TODA llamada:`,
    );
    for (const i of contractIssues) console.log(`  ${i}`);
    console.log("");
  }

  const ok =
    noTool.length === 0 &&
    noRule.length === 0 &&
    stale.length === 0 &&
    inventory.unmounted.length === 0 &&
    publicIssues.length === 0 &&
    contractIssues.length === 0;
  console.log(ok ? "✓ Cobertura completa." : "✗ Hay huecos (ver arriba).");
  process.exit(ok ? 0 : 1);
}

main();

import {
  CloudflareError,
  cloudflare,
  isConfigured,
  type CfDnsRecord,
  type CfZone,
} from "./cloudflare.client";
import {
  EXPECTED_RECORDS,
  FORBIDDEN_HOSTS,
  ZONE_DEFAULT,
  expectedFor,
  fqdn,
  proxyRuleFor,
  type ExpectedRecord,
} from "./dns.inventory";
import { DnsChangeModel } from "./dns.model";

/** Tipos que Cloudflare puede proxiar. En el resto, `proxied` ni se manda. */
const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);

export interface Actor {
  userId: string;
  email: string;
}

export interface RecordInput {
  type: string;
  /** Puede venir corto (`app`), como `@`, o ya como FQDN. */
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
}

/** Registro de Cloudflare + lo que el inventario opina de el. */
export interface AnnotatedRecord extends CfDnsRecord {
  /** Subdominio sin la zona. "@" para el apex. */
  host: string;
  expected: {
    service: string;
    purpose: string;
    group: ExpectedRecord["group"];
    severity: ExpectedRecord["severity"];
  } | null;
  /** Problemas detectados contra el inventario. */
  issues: Array<{ kind: string; message: string }>;
}

function err(status: number, message: string, code?: string) {
  const e = new Error(message) as Error & { status: number; code?: string };
  e.status = status;
  if (code) e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// Zona
// ---------------------------------------------------------------------------

/**
 * El zoneId no cambia nunca, asi que se resuelve una vez por proceso. Se cachea
 * solo el exito: si falla queremos que el proximo request lo reintente y no
 * quedar clavados en un error de arranque.
 */
let zoneCache: { id: string; name: string } | null = null;

async function resolveZone(): Promise<{ id: string; name: string }> {
  if (zoneCache) return zoneCache;

  const zoneName = (process.env.CLOUDFLARE_ZONE_NAME ?? ZONE_DEFAULT).trim();
  const explicitId = process.env.CLOUDFLARE_ZONE_ID?.trim();

  if (explicitId) {
    const zone = await cloudflare.getZone(explicitId);
    zoneCache = { id: zone.id, name: zone.name };
    return zoneCache;
  }

  const zone = await cloudflare.findZoneByName(zoneName);
  if (!zone) {
    throw err(
      404,
      `La zona ${zoneName} no aparece con este token. Revisa que el token incluya Zone:Zone:Read y que la zona este en sus Zone Resources, o setea CLOUDFLARE_ZONE_ID a mano.`,
      "zone_not_found",
    );
  }
  zoneCache = { id: zone.id, name: zone.name };
  return zoneCache;
}

// ---------------------------------------------------------------------------
// Normalizacion y guardarrailes
// ---------------------------------------------------------------------------

/** `app` → `app.bookfer.com`; `@` o "" → `bookfer.com`; FQDN se deja igual. */
function normalizeName(raw: string, zone: string): string {
  const n = raw.trim().replace(/\.$/, "").toLowerCase();
  if (n === "" || n === "@") return zone;
  if (n === zone) return zone;
  if (n.endsWith(`.${zone}`)) return n;
  return `${n}.${zone}`;
}

/** `app.bookfer.com` → `app`; la zona sola → `@`. */
function toHost(name: string, zone: string): string {
  const n = name.toLowerCase();
  if (n === zone) return "@";
  return n.endsWith(`.${zone}`) ? n.slice(0, -(zone.length + 1)) : n;
}

/**
 * Traduce el input del panel al body que espera Cloudflare.
 *
 * Dos reglas que Cloudflare aplica igual pero devolviendo un error feo:
 *  - `proxied` solo existe en A/AAAA/CNAME. En un TXT lo rechaza.
 *  - con `proxied: true` el TTL tiene que ser 1 (automatico): el edge decide.
 */
function toCloudflareBody(
  input: RecordInput,
  zone: string,
): Record<string, unknown> {
  const type = input.type.toUpperCase();
  const name = normalizeName(input.name, zone);
  const proxiable = PROXIABLE_TYPES.has(type);
  const proxied = proxiable ? (input.proxied ?? false) : undefined;

  const body: Record<string, unknown> = {
    type,
    name,
    content: input.content.trim(),
    ttl: proxied ? 1 : (input.ttl ?? 1),
  };
  if (proxiable) body.proxied = proxied;
  if (type === "MX") body.priority = input.priority ?? 10;
  if (input.comment !== undefined) body.comment = input.comment;

  return body;
}

/**
 * Los guardarrailes del inventario. Devuelve el motivo del bloqueo, o null.
 *
 * Solo bloquea PRENDER el proxy donde tiene que estar apagado, nunca al reves:
 * el orden documentado para el alta es crear todo en gris, esperar el
 * certificado y recien ahi pasar a naranja. Bloquear el gris romperia el
 * bootstrap.
 */
function proxyGuard(
  name: string,
  zone: string,
  proxied: boolean | undefined,
): string | null {
  if (proxied !== true) return null;
  const rule = proxyRuleFor(name, zone);
  if (!rule || rule.proxy !== false) return null;
  return (
    rule.warning ??
    `${name} tiene que quedar en gris (DNS only) segun el inventario.`
  );
}

function forbiddenGuard(name: string, zone: string): string | null {
  const hit = FORBIDDEN_HOSTS.find(
    (f) => fqdn(f.host, zone).toLowerCase() === name.toLowerCase(),
  );
  return hit ? hit.reason : null;
}

/** Que servicio se rompe si borras esto. null = no esta en el inventario. */
function requiredGuard(
  name: string,
  type: string,
  zone: string,
): string | null {
  const exp = expectedFor(name, type.toUpperCase(), zone);
  if (!exp || exp.severity !== "required") return null;
  return `${name} lo consume ${exp.service} (${exp.purpose}). Si lo borras, deja de resolver.`;
}

// ---------------------------------------------------------------------------
// Bitacora
// ---------------------------------------------------------------------------

async function logChange(entry: {
  action: "create" | "update" | "delete";
  zoneId: string;
  zoneName: string;
  record: CfDnsRecord | { id: string; name: string; type: string };
  before?: unknown;
  after?: unknown;
  actor: Actor;
  forced?: boolean;
  forcedReason?: string;
}): Promise<void> {
  try {
    await DnsChangeModel.create({
      action: entry.action,
      zoneId: entry.zoneId,
      zoneName: entry.zoneName,
      recordId: entry.record.id,
      name: entry.record.name,
      type: entry.record.type,
      before: entry.before ?? null,
      after: entry.after ?? null,
      forced: entry.forced ?? false,
      forcedReason: entry.forcedReason ?? "",
      actorId: entry.actor.userId,
      actorEmail: entry.actor.email,
    });
  } catch (e: any) {
    // El cambio en Cloudflare ya esta hecho. No se revierte por un fallo de
    // bitacora: revertir un DNS a ciegas es peor que el hueco en el registro.
    console.error("[dns] no se pudo guardar el cambio en la bitacora:", e?.message ?? e);
  }
}

/** Snapshot chico para el antes/despues. El objeto entero es ruido. */
function snapshot(r: CfDnsRecord) {
  return {
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl,
    proxied: r.proxied ?? null,
    priority: r.priority ?? null,
    comment: r.comment ?? "",
  };
}

// ---------------------------------------------------------------------------
// Anotacion contra el inventario
// ---------------------------------------------------------------------------

function annotate(r: CfDnsRecord, zone: string): AnnotatedRecord {
  const exp = expectedFor(r.name, r.type, zone);
  const issues: AnnotatedRecord["issues"] = [];

  const rule = proxyRuleFor(r.name, zone);
  if (rule && rule.proxy !== null && (r.proxied ?? false) !== rule.proxy) {
    issues.push({
      kind: "proxy_mismatch",
      message:
        rule.proxy === false
          ? (rule.warning ?? "Deberia estar en gris (DNS only).")
          : (rule.warning ?? "Deberia estar en naranja (proxied)."),
    });
  }

  const forbidden = forbiddenGuard(r.name, zone);
  if (forbidden) issues.push({ kind: "forbidden", message: forbidden });

  return {
    ...r,
    host: toHost(r.name, zone),
    expected: exp
      ? {
          service: exp.service,
          purpose: exp.purpose,
          group: exp.group,
          severity: exp.severity,
        }
      : null,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export const dnsService = {
  /**
   * Estado del modulo. Nunca tira: si no hay token o el token esta mal, lo
   * dice en el payload para que la UI muestre las instrucciones en vez de un
   * error rojo sin contexto.
   */
  async status(): Promise<{
    configured: boolean;
    tokenValid: boolean;
    zone: {
      id: string;
      name: string;
      status: string;
      paused: boolean;
      plan: string;
      nameServers: string[];
    } | null;
    recordCount: number | null;
    error: string | null;
    envVars: { token: string; zoneId: string; zoneName: string };
  }> {
    const envVars = {
      token: "CLOUDFLARE_DNS_API_TOKEN",
      zoneId: "CLOUDFLARE_ZONE_ID",
      zoneName: "CLOUDFLARE_ZONE_NAME",
    };

    if (!isConfigured()) {
      return {
        configured: false,
        tokenValid: false,
        zone: null,
        recordCount: null,
        error: null,
        envVars,
      };
    }

    try {
      const verified = await cloudflare.verifyToken();
      const tokenValid = verified.status === "active";
      if (!tokenValid) {
        return {
          configured: true,
          tokenValid: false,
          zone: null,
          recordCount: null,
          error: `El token existe pero su estado es "${verified.status}".`,
          envVars,
        };
      }

      const { id } = await resolveZone();
      const zone: CfZone = await cloudflare.getZone(id);
      const records = await cloudflare.listRecords(id);

      return {
        configured: true,
        tokenValid: true,
        zone: {
          id: zone.id,
          name: zone.name,
          status: zone.status,
          paused: zone.paused ?? false,
          plan: zone.plan?.name ?? "—",
          nameServers: zone.name_servers ?? [],
        },
        recordCount: records.length,
        error: null,
        envVars,
      };
    } catch (e: any) {
      return {
        configured: true,
        tokenValid: false,
        zone: null,
        recordCount: null,
        error: e?.message ?? "Error hablando con Cloudflare",
        envVars,
      };
    }
  },

  async list(filters: { type?: string; q?: string } = {}): Promise<{
    zone: { id: string; name: string };
    data: AnnotatedRecord[];
    total: number;
  }> {
    const zone = await resolveZone();
    const raw = await cloudflare.listRecords(zone.id);

    let rows = raw.map((r) => annotate(r, zone.name));

    if (filters.type) {
      const t = filters.type.toUpperCase();
      rows = rows.filter((r) => r.type === t);
    }
    if (filters.q) {
      const q = filters.q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q) ||
          (r.comment ?? "").toLowerCase().includes(q) ||
          (r.expected?.service ?? "").toLowerCase().includes(q),
      );
    }

    // Orden estable: primero los que tienen problema, despues por nombre. El
    // apex arriba de todo porque es la raiz de la zona.
    rows.sort((a, b) => {
      if (a.issues.length !== b.issues.length) {
        return b.issues.length - a.issues.length;
      }
      if (a.host === "@" && b.host !== "@") return -1;
      if (b.host === "@" && a.host !== "@") return 1;
      return a.name.localeCompare(b.name) || a.type.localeCompare(b.type);
    });

    return { zone, data: rows, total: rows.length };
  },

  async create(
    input: RecordInput,
    actor: Actor,
    force = false,
  ): Promise<AnnotatedRecord> {
    const zone = await resolveZone();
    const body = toCloudflareBody(input, zone.name);
    const name = body.name as string;

    const blockers = [
      proxyGuard(name, zone.name, body.proxied as boolean | undefined),
      forbiddenGuard(name, zone.name),
    ].filter(Boolean) as string[];

    if (blockers.length > 0 && !force) {
      throw err(409, blockers.join(" "), "guardrail");
    }

    const created = await cloudflare.createRecord(zone.id, body);
    await logChange({
      action: "create",
      zoneId: zone.id,
      zoneName: zone.name,
      record: created,
      after: snapshot(created),
      actor,
      forced: blockers.length > 0,
      forcedReason: blockers.join(" "),
    });

    return annotate(created, zone.name);
  },

  async update(
    recordId: string,
    patch: Partial<RecordInput>,
    actor: Actor,
    force = false,
  ): Promise<AnnotatedRecord> {
    const zone = await resolveZone();
    const current = await cloudflare.getRecord(zone.id, recordId);
    if (!current) throw err(404, "El registro no existe en la zona", "not_found");

    // El tipo y el nombre no se editan: cambiarlos es borrar y crear otro
    // registro. Cloudflare lo permite y despues nadie entiende la bitacora.
    const merged: RecordInput = {
      type: current.type,
      name: current.name,
      content: patch.content ?? current.content,
      ttl: patch.ttl ?? current.ttl,
      proxied: patch.proxied ?? current.proxied,
      priority: patch.priority ?? current.priority,
      comment: patch.comment ?? current.comment ?? "",
    };
    const body = toCloudflareBody(merged, zone.name);

    const blocker = proxyGuard(
      current.name,
      zone.name,
      body.proxied as boolean | undefined,
    );
    if (blocker && !force) throw err(409, blocker, "guardrail");

    const updated = await cloudflare.updateRecord(zone.id, recordId, body);
    await logChange({
      action: "update",
      zoneId: zone.id,
      zoneName: zone.name,
      record: updated,
      before: snapshot(current),
      after: snapshot(updated),
      actor,
      forced: Boolean(blocker),
      forcedReason: blocker ?? "",
    });

    return annotate(updated, zone.name);
  },

  async remove(recordId: string, actor: Actor, force = false): Promise<void> {
    const zone = await resolveZone();
    const current = await cloudflare.getRecord(zone.id, recordId);
    if (!current) throw err(404, "El registro no existe en la zona", "not_found");

    const blocker = requiredGuard(current.name, current.type, zone.name);
    if (blocker && !force) throw err(409, blocker, "guardrail");

    await cloudflare.deleteRecord(zone.id, recordId);
    await logChange({
      action: "delete",
      zoneId: zone.id,
      zoneName: zone.name,
      record: current,
      before: snapshot(current),
      actor,
      forced: Boolean(blocker),
      forcedReason: blocker ?? "",
    });
  },

  /**
   * Compara la zona real contra el inventario del monorepo.
   *
   * Es lo que este modulo hace y el panel de Cloudflare no: Cloudflare sabe que
   * registros hay, no cuales TIENE que haber ni por que.
   */
  async audit(): Promise<{
    zone: { id: string; name: string };
    summary: {
      ok: number;
      missing: number;
      proxyMismatch: number;
      forbidden: number;
      unknown: number;
    };
    rows: Array<{
      host: string;
      name: string;
      types: string[];
      service: string;
      purpose: string;
      group: string;
      severity: string;
      expectedProxy: boolean | null;
      status: "ok" | "missing" | "proxy_mismatch";
      warning?: string;
      suggestedContent?: string;
      actual: {
        id: string;
        type: string;
        content: string;
        ttl: number;
        proxied: boolean | null;
      } | null;
    }>;
    forbidden: Array<{ name: string; reason: string; recordId: string }>;
    unknown: Array<{
      id: string;
      name: string;
      type: string;
      content: string;
      proxied: boolean | null;
    }>;
  }> {
    const zone = await resolveZone();
    const actual = await cloudflare.listRecords(zone.id);
    const matched = new Set<string>();

    const rows = EXPECTED_RECORDS.map((exp) => {
      const name = fqdn(exp.host, zone.name);
      const hit = actual.find(
        (r) =>
          r.name.toLowerCase() === name.toLowerCase() &&
          exp.types.includes(r.type),
      );
      if (hit) matched.add(hit.id);

      let status: "ok" | "missing" | "proxy_mismatch" = "ok";
      if (!hit) status = "missing";
      else if (exp.proxy !== null && (hit.proxied ?? false) !== exp.proxy) {
        status = "proxy_mismatch";
      }

      return {
        host: exp.host === "" ? "@" : exp.host,
        name,
        types: exp.types,
        service: exp.service,
        purpose: exp.purpose,
        group: exp.group,
        severity: exp.severity,
        expectedProxy: exp.proxy,
        status,
        warning: exp.warning,
        suggestedContent: exp.suggestedContent,
        actual: hit
          ? {
              id: hit.id,
              type: hit.type,
              content: hit.content,
              ttl: hit.ttl,
              proxied: hit.proxied ?? null,
            }
          : null,
      };
    });

    const forbidden = actual
      .map((r) => {
        const reason = forbiddenGuard(r.name, zone.name);
        return reason ? { name: r.name, reason, recordId: r.id } : null;
      })
      .filter(Boolean) as Array<{
      name: string;
      reason: string;
      recordId: string;
    }>;
    const forbiddenIds = new Set(forbidden.map((f) => f.recordId));

    // Todo lo que esta en la zona y no esta en el inventario. No es un error:
    // puede ser una verificacion de Google o un TXT de un proveedor. Se lista
    // para que se pueda revisar, no para que moleste.
    const unknown = actual
      .filter((r) => !matched.has(r.id) && !forbiddenIds.has(r.id))
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        content: r.content,
        proxied: r.proxied ?? null,
      }));

    return {
      zone,
      summary: {
        ok: rows.filter((r) => r.status === "ok").length,
        missing: rows.filter((r) => r.status === "missing").length,
        proxyMismatch: rows.filter((r) => r.status === "proxy_mismatch").length,
        forbidden: forbidden.length,
        unknown: unknown.length,
      },
      rows,
      forbidden,
      unknown,
    };
  },

  async changelog(limit = 50) {
    const rows = await DnsChangeModel.find({})
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Math.max(1, limit)))
      .lean();
    return rows;
  },
};

export { CloudflareError };

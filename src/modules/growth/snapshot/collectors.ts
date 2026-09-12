/**
 * Recolectores del PropertySnapshot: una función por fuente, cada una con su
 * propio timeout, y ninguna capaz de tumbar el turno.
 *
 * Dos caminos de lectura, elegidos por costo y no por gusto:
 *
 *  - **DB del PMS directa** para documentos de la propia propiedad (sitio,
 *    LinkHub, GBP, OTAs, reseñas, unidades, categorías, visibilidad). El
 *    `propertyId` ya viene validado por `resolveUserScope` antes de llegar acá,
 *    así que pasar por HTTP sería mintear un JWT y atravesar el proxy para leer
 *    lo mismo que `pmsContextResolver` ya lee así hoy.
 *  - **HTTP con JWT delegado** para lo que vive detrás de lógica de negocio
 *    (pace del RMS, reporte de dashboard, motor de reservas, reglas). Ahí el
 *    documento crudo no alcanza: el endpoint calcula.
 *
 * Ninguna de estas funciones lanza. Devuelven `null` y el bloque queda
 * declarado como faltante.
 */

import { Schema, type Model } from "mongoose";
import { getPmsConnection } from "../../../shared/pmsDb";
import { pmsRequest } from "../../../shared/middleware/pmsProxy";
import { listSignals } from "../../intelligence/intelligence.service";

/** Timeout por fuente. Una lenta no puede arrastrar al turno entero. */
export const SOURCE_TIMEOUT_MS = Number(
  process.env.GROWTH_SNAPSHOT_TIMEOUT_MS ?? 2500,
);

/** Radio alrededor de la propiedad para las señales de mercado. */
export const MARKET_RADIUS_KM = Number(process.env.GROWTH_MARKET_RADIUS_KM ?? 30);

/** Techo de reseñas que se traen para agregar. Suficiente para rating y ratio. */
const REVIEWS_LIMIT = 500;

type Doc = Record<string, unknown>;

/**
 * Corre `fn` con techo de tiempo. Un fallo o un timeout devuelve `null` y deja
 * un warn: el turno sigue y el bloque se declara faltante.
 */
export async function withTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    console.warn(
      `[growth/snapshot] ${label} falló:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Modelos de lectura sobre la DB del PMS ───────────────────────────────────
//
// `strict: false` a propósito: sólo se declaran los campos que se leen, y los
// modelos del PMS evolucionan sin avisarle a este repo. Declarar de más acá
// significa romperse cuando allá renombran algo que no se usa.

const loose = (collection: string) =>
  new Schema({}, { strict: false, collection });

const modelCache = new Map<string, Model<Doc>>();

async function pmsModel(name: string, collection: string): Promise<Model<Doc>> {
  const cached = modelCache.get(name);
  if (cached) return cached;
  const conn = await getPmsConnection();
  const model = conn.model<Doc>(name, loose(collection));
  modelCache.set(name, model);
  return model;
}

// ── Identidad ────────────────────────────────────────────────────────────────

export async function collectProperty(propertyId: string): Promise<Doc | null> {
  return withTimeout("property", async () => {
    const Property = await pmsModel("GrowthProperty", "properties");
    return Property.findOne(
      { propertyId },
      {
        propertyId: 1,
        companyId: 1,
        name: 1,
        type: 1,
        salesModel: 1,
        currency: 1,
        address: 1,
        createdAt: 1,
      },
    ).lean();
  });
}

export async function collectInventoryCounts(
  propertyId: string,
): Promise<{ units: number; categories: number } | null> {
  return withTimeout("inventory", async () => {
    const [Unit, Category] = await Promise.all([
      pmsModel("GrowthUnit", "units"),
      pmsModel("GrowthCategory", "categories"),
    ]);
    const [units, categories] = await Promise.all([
      Unit.countDocuments({ propertyId, isActive: { $ne: false } }),
      Category.countDocuments({ propertyId, isActive: { $ne: false } }),
    ]);
    return { units, categories };
  });
}

// ── Presencia digital ────────────────────────────────────────────────────────

export async function collectSites(
  propertyId: string,
  companyId: string,
): Promise<Doc[] | null> {
  return withTimeout("sites", async () => {
    const Site = await pmsModel("GrowthSite", "sites");
    // Proyección explícita y deliberada: el documento del sitio incluye los
    // ÁRBOLES DE COMPONENTES de cada página (cientos de KB). Acá sólo hacen
    // falta los estados de publicación.
    return Site.find(
      { companyId },
      { name: 1, status: 1, "sitesByLanguage.status": 1, "sitesByLanguage.publishedAt": 1, "sitesByLanguage.propertyId": 1, "sitesByLanguage.language": 1 },
    )
      .limit(20)
      .lean();
  });
}

export async function collectLinkhub(propertyId: string): Promise<Doc | null> {
  return withTimeout("linkhub", async () => {
    const Linkhub = await pmsModel("GrowthLinkhub", "linkhubpages");
    return Linkhub.findOne(
      { propertyId },
      { published: 1, status: 1, publishedAt: 1, slug: 1 },
    ).lean();
  });
}

export async function collectVisibility(propertyId: string): Promise<Doc | null> {
  return withTimeout("visibility", async () => {
    const Snapshot = await pmsModel("GrowthVisibility", "visibilitysnapshots");
    // La computa socialHubSnapshotJob: se lee la última foto, no se recalcula.
    return Snapshot.findOne({ propertyId }, { scores: 1, inputs: 1, date: 1 })
      .sort({ date: -1 })
      .lean();
  });
}

export async function collectGbp(propertyId: string): Promise<Doc | null> {
  return withTimeout("gbp", async () => {
    const Gbp = await pmsModel("GrowthGbp", "gbpprofiles");
    return Gbp.findOne(
      { propertyId },
      { business: 1, location: 1, photos: 1, syncState: 1 },
    ).lean();
  });
}

export async function collectOtas(propertyId: string): Promise<Doc[] | null> {
  return withTimeout("otas", async () => {
    const Ota = await pmsModel("GrowthOta", "otaprofiles");
    return Ota.find(
      { propertyId },
      {
        platform: 1,
        description: 1,
        policies: 1,
        "roomTypes.photoUrl": 1,
        "roomTypes.included": 1,
      },
    ).lean();
  });
}

export async function collectSocialConnections(
  propertyId: string,
): Promise<Doc[] | null> {
  return withTimeout("social", async () => {
    const Conn = await pmsModel("GrowthSocialConn", "socialconnections");
    return Conn.find({ propertyId }, { platform: 1, status: 1 }).lean();
  });
}

// ── Reputación ───────────────────────────────────────────────────────────────

export async function collectReviews(propertyId: string): Promise<Doc[] | null> {
  return withTimeout("reviews", async () => {
    const Review = await pmsModel("GrowthReview", "reviews");
    return Review.find(
      { propertyId, isActive: { $ne: false } },
      { rating: 1, responded: 1, reviewDate: 1, createdAt: 1 },
    )
      .sort({ reviewDate: -1 })
      .limit(REVIEWS_LIMIT)
      .lean();
  });
}

// ── Fuentes HTTP (identidad delegada) ────────────────────────────────────────

export interface HttpContext {
  propertyId: string;
  companyId?: string;
  /** JWT delegado del usuario. Sin él sólo responden los endpoints públicos. */
  agentJwt?: string;
}

type Service = "pms-core" | "booking-app" | "rooms-app" | "rms-app" | "staypass";

async function get<T = unknown>(
  label: string,
  service: Service,
  path: string,
  ctx: HttpContext,
  query?: Record<string, string | number | undefined>,
): Promise<T | null> {
  return withTimeout(label, () =>
    pmsRequest<T>({
      service,
      method: "GET",
      path,
      query,
      agentJwt: ctx.agentJwt,
      timeoutMs: SOURCE_TIMEOUT_MS,
    }),
  );
}

export function collectPace(ctx: HttpContext) {
  return get("pace", "rms-app", "/api/v1/rms/pace/snapshot-today", ctx, {
    propertyId: ctx.propertyId,
  });
}

export function collectDashboard(ctx: HttpContext) {
  return get("dashboard", "booking-app", "/api/v1/reports/dashboard", ctx, {
    propertyId: ctx.propertyId,
  });
}

export function collectEngineSettings(ctx: HttpContext) {
  return get("engine-settings", "booking-app", "/api/v1/engine-settings", ctx, {
    propertyId: ctx.propertyId,
  });
}

export function collectRatePlans(ctx: HttpContext) {
  return get("rate-plans", "booking-app", "/api/v1/rate-plans", ctx, {
    propertyId: ctx.propertyId,
  });
}

export function collectPromos(ctx: HttpContext) {
  return get("promos", "booking-app", "/api/v1/promos", ctx, {
    propertyId: ctx.propertyId,
  });
}

export function collectRestrictions(ctx: HttpContext) {
  const today = new Date().toISOString().slice(0, 10);
  const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  return get("restrictions", "booking-app", "/api/v1/day-restrictions", ctx, {
    propertyId: ctx.propertyId,
    from: today,
    to: in90,
  });
}

export function collectPricingRules(ctx: HttpContext) {
  return get("rules", "rms-app", "/api/v1/rms/rules", ctx, {
    propertyId: ctx.propertyId,
  });
}

export function collectRecommendations(ctx: HttpContext) {
  return get("recommendations", "rms-app", "/api/v1/rms/recommendations", ctx, {
    propertyId: ctx.propertyId,
    status: "suggested",
  });
}

/**
 * Config del RMS. De acá sale si hay comp-set (`competitors[]`), que es lo
 * único que el snapshot necesita: la GRILLA de tarifas de la competencia vive
 * en `/compset-rates` y pesa mucho más de lo que aporta a un diagnóstico.
 */
export function collectRmsConfig(ctx: HttpContext) {
  return get("rms-config", "rms-app", "/api/v1/rms/config", ctx, {
    propertyId: ctx.propertyId,
  });
}

// ── Mercado (intelligence-hub, mismo proceso) ────────────────────────────────

/**
 * Señales alrededor de la propiedad. Corre en el mismo proceso que el hub, así
 * que no hay HTTP: es una query a Mongo con caja geográfica.
 *
 * Sin lat/lng no se consulta: el hub filtra por caja alrededor de un punto y
 * pedirle "el país entero" devolvería eventos a 900 km que no le sirven a nadie.
 */
export async function collectMarketSignals(input: {
  lat: number | null;
  lng: number | null;
  now: Date;
}): Promise<Doc[] | null> {
  if (input.lat === null || input.lng === null) return null;
  return withTimeout("market", async () => {
    const from = input.now.toISOString();
    const to = new Date(input.now.getTime() + 90 * 86_400_000).toISOString();
    const signals = await listSignals({
      lat: input.lat as number,
      lng: input.lng as number,
      radiusKm: MARKET_RADIUS_KM,
      from,
      to,
      limit: 200,
    });
    return signals as unknown as Doc[];
  });
}

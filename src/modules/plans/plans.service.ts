import { makeId } from "../../shared/utils/ids";
import {
  Plan,
  PlanPageContent,
  Product,
  sanitize,
  slugify,
  type PlanStatus,
  type ProductStatus,
} from "./plans.model";
import { PRODUCT_SEED } from "./productCatalog";
import {
  PLAN_PAGE_FIELD_KEYS,
  PLAN_PAGE_LOCALES,
} from "./planPageFields";

interface HttpError extends Error {
  status: number;
  code?: string;
}
function httpError(status: number, message: string, code?: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

/* ------------------------- Productos ------------------------- */

interface ProductFilters {
  status?: ProductStatus;
  category?: string;
  search?: string;
}

export const productsService = {
  async list(filters: ProductFilters = {}) {
    const q: Record<string, unknown> = {};
    if (filters.status) q.status = filters.status;
    if (filters.category) q.category = filters.category;
    if (filters.search) {
      const rx = new RegExp(escapeRx(filters.search), "i");
      q.$or = [{ name: rx }, { key: rx }, { description: rx }];
    }
    const docs = await Product.find(q).sort({ order: 1, name: 1 }).lean();
    return docs.map(sanitize);
  },

  async getOne(id: string) {
    const doc = await Product.findOne({
      $or: [{ productId: id }, { key: id }],
    }).lean();
    return doc ? sanitize(doc) : null;
  },

  async create(input: Record<string, any>, userId: string) {
    const key = String(input.key).trim();
    const exists = await Product.findOne({ key }).lean();
    if (exists) {
      throw httpError(
        409,
        `Ya existe un producto con la clave "${key}"`,
        "duplicate_key",
      );
    }
    const doc = await Product.create({
      ...input,
      key,
      productId: makeId("prod"),
      createdByUserId: userId,
    });
    return sanitize(doc);
  },

  async update(id: string, patch: Record<string, any>) {
    const doc = await Product.findOneAndUpdate(
      { $or: [{ productId: id }, { key: id }] },
      { $set: patch },
      { new: true },
    );
    if (!doc) throw httpError(404, "Producto no encontrado", "not_found");
    return sanitize(doc);
  },

  /**
   * Borrar un producto que algun plan incluye dejaria ese plan apuntando a la
   * nada: el snapshot de las companies que lo eligieron seguiria nombrandolo y
   * el gate del PMS no sabria que hacer con esa key. Se archiva en su lugar.
   */
  async remove(id: string) {
    const doc = await Product.findOne({ $or: [{ productId: id }, { key: id }] });
    if (!doc) throw httpError(404, "Producto no encontrado", "not_found");
    const usedBy = await Plan.countDocuments({ productKeys: doc.key });
    if (usedBy > 0) {
      throw httpError(
        409,
        `El producto esta incluido en ${usedBy} ${usedBy === 1 ? "plan" : "planes"}. Archivalo en vez de borrarlo, o sacalo de esos planes primero.`,
        "product_in_use",
      );
    }
    await doc.deleteOne();
    return { deleted: true, key: doc.key };
  },

  /**
   * Siembra el catalogo base. Idempotente por `key`: crea lo que falta y deja
   * intacto lo que ya existe (un operador pudo haber editado nombre o textos).
   */
  async seed(userId = "seed") {
    let created = 0;
    for (const item of PRODUCT_SEED) {
      const exists = await Product.findOne({ key: item.key }).lean();
      if (exists) continue;
      await Product.create({
        ...item,
        productId: makeId("prod"),
        status: "active",
        createdByUserId: userId,
      });
      created += 1;
    }
    const total = await Product.countDocuments();
    return { created, total };
  },
};

/* -------------------------- Planes --------------------------- */

interface PlanFilters {
  status?: PlanStatus;
  public?: boolean;
  search?: string;
}

export const plansService = {
  async list(filters: PlanFilters = {}) {
    const q: Record<string, unknown> = {};
    if (filters.status) q.status = filters.status;
    if (filters.public !== undefined) q.public = filters.public;
    if (filters.search) {
      const rx = new RegExp(escapeRx(filters.search), "i");
      q.$or = [{ name: rx }, { slug: rx }, { description: rx }];
    }
    const docs = await Plan.find(q).sort({ order: 1, name: 1 }).lean();
    return docs.map(sanitize);
  },

  async getOne(id: string) {
    const doc = await Plan.findOne({
      $or: [{ planId: id }, { slug: id }],
    }).lean();
    return doc ? sanitize(doc) : null;
  },

  async create(input: Record<string, any>, userId: string) {
    const name = String(input.name).trim();
    const slug = await uniqueSlug(
      input.slug ? String(input.slug) : slugify(name),
    );
    const doc = await Plan.create({
      ...input,
      name,
      slug,
      planId: makeId("plan"),
      createdByUserId: userId,
    });
    return sanitize(doc);
  },

  async update(id: string, patch: Record<string, any>) {
    const current = await Plan.findOne({ $or: [{ planId: id }, { slug: id }] });
    if (!current) throw httpError(404, "Plan no encontrado", "not_found");

    const next: Record<string, any> = { ...patch };
    if (next.slug && next.slug !== current.slug) {
      next.slug = await uniqueSlug(String(next.slug), current.planId);
    }

    // Un plan gratis sin vencimiento no es un plan, es un hueco de
    // facturacion: la cuenta se queda adentro para siempre sin pagar. Se
    // valida aca y no solo en Joi porque `free` y `freeDurationDays` pueden
    // llegar en PATCHs distintos.
    const free = next.free ?? current.free;
    const days =
      next.freeDurationDays !== undefined
        ? next.freeDurationDays
        : current.freeDurationDays;
    if (free && !days) {
      throw httpError(
        400,
        "Un plan gratuito necesita una duracion en dias: sin vencimiento la cuenta queda gratis para siempre.",
        "free_needs_duration",
      );
    }
    if (!free) next.freeDurationDays = null;

    // Publicarlo con la lista de productos vacia dejaria a quien lo elija con
    // el escritorio pelado y nada mas.
    const status = next.status ?? current.status;
    const keys = next.productKeys ?? current.productKeys;
    if (status === "active" && (!keys || keys.length === 0)) {
      throw httpError(
        400,
        "Un plan activo tiene que incluir al menos un producto.",
        "plan_needs_products",
      );
    }

    next.version = (current.version ?? 1) + 1;
    const doc = await Plan.findOneAndUpdate(
      { planId: current.planId },
      { $set: next },
      { new: true },
    );
    return sanitize(doc!);
  },

  async remove(id: string) {
    const doc = await Plan.findOne({ $or: [{ planId: id }, { slug: id }] });
    if (!doc) throw httpError(404, "Plan no encontrado", "not_found");
    if (doc.status === "active") {
      throw httpError(
        409,
        "No se puede borrar un plan activo: puede haber companies con el elegido. Archivalo primero.",
        "plan_active",
      );
    }
    await doc.deleteOne();
    return { deleted: true, planId: doc.planId };
  },

  /**
   * Expande un plan a lo que el PMS necesita para decidir accesos.
   *
   * Devuelve dos mitades y las dos importan: lo incluido (apps y rutas que se
   * abren) y lo bloqueado (los productos que existen en la plataforma pero no
   * en este plan). El PMS no oculta lo bloqueado —lo muestra y avisa con un
   * popup al intentar entrar—, asi que necesita saber por que nombre llamar a
   * lo que no incluye.
   *
   * Los productos `core` entran siempre, este el plan como este: sin el
   * escritorio ni las propiedades no se puede ni configurar la empresa.
   */
  async entitlementsOf(plan: Record<string, any>) {
    const products = await Product.find({ status: "active" })
      .sort({ order: 1, name: 1 })
      .lean();

    const wanted = new Set<string>(plan.productKeys ?? []);
    const included: any[] = [];
    const locked: any[] = [];
    for (const p of products) {
      if (p.core || wanted.has(p.key)) included.push(p);
      else locked.push(p);
    }

    const view = (p: any) => ({
      key: p.key,
      name: p.name,
      description: p.description ?? "",
      category: p.category,
      icon: p.icon ?? "",
      appIds: p.appIds ?? [],
      routes: p.routes ?? [],
      core: Boolean(p.core),
    });

    const allowedAppIds = unique(included.flatMap((p) => p.appIds ?? []));
    const allowedRoutes = unique(included.flatMap((p) => p.routes ?? []));

    // Lo que un producto incluido habilita no queda bloqueado aunque un
    // producto sin incluir tambien lo nombre: el permiso mas amplio gana. Sin
    // este descuento, dos productos que comparten una app o una ruta se
    // pisaban y el gate cerraba algo que el plan si daba.
    const lockedAppIds = unique(
      locked.flatMap((p) => p.appIds ?? []),
    ).filter((id) => !allowedAppIds.includes(id));
    const lockedRoutes = unique(
      locked.flatMap((p) => p.routes ?? []),
    ).filter((r) => !allowedRoutes.includes(r));

    return {
      planId: plan.planId,
      slug: plan.slug,
      name: plan.name,
      tagline: plan.tagline ?? "",
      description: plan.description ?? "",
      price: plan.price ?? { amount: 0, currency: "USD", period: "monthly" },
      free: Boolean(plan.free),
      freeDurationDays: plan.freeDurationDays ?? null,
      trialDays: plan.trialDays ?? 0,
      limits: plan.limits ?? {},
      status: plan.status,
      highlighted: Boolean(plan.highlighted),
      order: plan.order ?? 100,
      version: plan.version ?? 1,
      productKeys: included.map((p) => p.key),
      products: included.map(view),
      lockedProducts: locked.map(view),
      allowedAppIds,
      allowedRoutes,
      lockedAppIds,
      lockedRoutes,
    };
  },

  /** Catalogo que ve el hotelero al terminar el alta. */
  async publicCatalog() {
    const plans = await Plan.find({ status: "active", public: true })
      .sort({ order: 1, name: 1 })
      .lean();
    const resolved = [];
    for (const p of plans) resolved.push(await this.entitlementsOf(p));
    return resolved;
  },

  /** Entitlements de un plan puntual, por id o slug. */
  async entitlements(planId: string) {
    const plan = await Plan.findOne({
      $or: [{ planId }, { slug: planId }],
    }).lean();
    if (!plan) throw httpError(404, "Plan no encontrado", "not_found");
    return this.entitlementsOf(plan);
  },
};

/* -------------------------- Helpers -------------------------- */

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRx(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function uniqueSlug(
  base: string,
  ignorePlanId?: string,
): Promise<string> {
  const root = slugify(base) || "plan";
  let candidate = root;
  let n = 2;
  // Hasta 50 intentos: mas que eso es alguien creando "plan" en un bucle.
  while (n < 50) {
    const clash = await Plan.findOne({
      slug: candidate,
      ...(ignorePlanId ? { planId: { $ne: ignorePlanId } } : {}),
    }).lean();
    if (!clash) return candidate;
    candidate = `${root}-${n}`;
    n += 1;
  }
  return `${root}-${Date.now()}`;
}

/* ─────────────── Contenido de la pantalla /planes ─────────────── */

export const planPageContentService = {
  /**
   * Los textos cargados, normalizados: un bloque por idioma, solo con los
   * campos del catalogo y sin cadenas vacias.
   *
   * Se limpia al leer y no al guardar porque el catalogo de campos puede
   * cambiar (se agrega o se retira uno) y el documento guardado no: filtrar
   * aca evita que un campo retirado siga viajando al PMS para siempre.
   */
  async get(): Promise<Record<string, Record<string, string>>> {
    const doc = await PlanPageContent.findOne({ key: CONTENT_KEY }).lean();
    return normalizeLocales((doc?.locales ?? {}) as Record<string, unknown>);
  },

  /** El documento entero para el editor (incluye metadata de auditoria). */
  async getForEditor() {
    const doc = await PlanPageContent.findOne({ key: CONTENT_KEY }).lean();
    return {
      locales: normalizeLocales((doc?.locales ?? {}) as Record<string, unknown>),
      updatedByUserId: doc?.updatedByUserId ?? "",
      version: doc?.version ?? 0,
      updatedAt: doc?.updatedAt ?? null,
    };
  },

  /**
   * Reemplaza el contenido completo. Es un PUT y no un PATCH por campo: el
   * editor manda siempre los cinco idiomas, y borrar un texto (dejarlo vacio
   * para volver al default) tiene que poder expresarse.
   */
  async replace(
    locales: Record<string, Record<string, string>>,
    userId: string,
  ) {
    const clean = normalizeLocales(locales);
    const doc = await PlanPageContent.findOneAndUpdate(
      { key: CONTENT_KEY },
      {
        $set: { locales: clean, updatedByUserId: userId },
        $inc: { version: 1 },
        $setOnInsert: { key: CONTENT_KEY },
      },
      { new: true, upsert: true },
    ).lean();
    return {
      locales: clean,
      updatedByUserId: doc?.updatedByUserId ?? userId,
      version: doc?.version ?? 1,
      updatedAt: doc?.updatedAt ?? null,
    };
  },
};

const CONTENT_KEY = "plan_selection";

function normalizeLocales(
  raw: Record<string, unknown>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const locale of PLAN_PAGE_LOCALES) {
    const block = raw?.[locale];
    if (!block || typeof block !== "object") continue;
    const fields: Record<string, string> = {};
    for (const key of PLAN_PAGE_FIELD_KEYS) {
      const value = (block as Record<string, unknown>)[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      // Vacio == "usa el default". Se descarta para que el PMS no reciba una
      // cadena en blanco y pinte un hueco donde deberia ir el texto original.
      if (trimmed) fields[key] = trimmed;
    }
    if (Object.keys(fields).length > 0) out[locale] = fields;
  }
  return out;
}

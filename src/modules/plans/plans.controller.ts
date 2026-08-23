import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import {
  planPageContentService,
  plansService,
  productsService,
} from "./plans.service";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
} from "./productCatalog";
import {
  PLAN_PAGE_FIELDS,
  PLAN_PAGE_GROUPS,
  PLAN_PAGE_LOCALES,
  PLAN_PAGE_LOCALE_LABELS,
} from "./planPageFields";
import {
  createPlanSchema,
  replacePlanPageContentSchema,
  createProductSchema,
  listPlansSchema,
  listProductsSchema,
  updatePlanSchema,
  updateProductSchema,
} from "./plans.validation";

function handleErr(res: Response, err: unknown) {
  const e = err as { status?: number; message?: string; code?: string };
  return fail(
    res,
    e.status ?? 500,
    e.message ?? "Error interno",
    e.code ?? "error",
  );
}

export const productsController = {
  // Categorias con su etiqueta: el front arma los filtros y el select sin
  // duplicar la lista.
  async categories(_req: Request, res: Response) {
    return ok(res, {
      categories: PRODUCT_CATEGORIES.map((key) => ({
        key,
        label: PRODUCT_CATEGORY_LABELS[key] ?? key,
      })),
    });
  },

  async list(req: Request, res: Response) {
    const { error, value } = listProductsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const data = await productsService.list(value);
    return ok(res, { data, total: data.length });
  },

  async getOne(req: Request, res: Response) {
    const doc = await productsService.getOne(req.params.id);
    if (!doc) return fail(res, 404, "Producto no encontrado", "not_found");
    return ok(res, doc);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createProductSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await productsService.create(
        value,
        req.internalUser?.userId ?? "unknown",
      );
      return ok(res, doc, 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateProductSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await productsService.update(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async remove(req: Request, res: Response) {
    try {
      return ok(res, await productsService.remove(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async seed(req: Request, res: Response) {
    const result = await productsService.seed(
      req.internalUser?.userId ?? "unknown",
    );
    return ok(res, result);
  },
};

export const plansController = {
  async list(req: Request, res: Response) {
    const { error, value } = listPlansSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const data = await plansService.list(value);
    return ok(res, { data, total: data.length });
  },

  async getOne(req: Request, res: Response) {
    const doc = await plansService.getOne(req.params.id);
    if (!doc) return fail(res, 404, "Plan no encontrado", "not_found");
    return ok(res, doc);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createPlanSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await plansService.create(
        value,
        req.internalUser?.userId ?? "unknown",
      );
      return ok(res, doc, 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async update(req: Request, res: Response) {
    const { error, value } = updatePlanSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await plansService.update(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async remove(req: Request, res: Response) {
    try {
      return ok(res, await plansService.remove(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // Vista previa de lo que va a recibir una company con este plan: productos
  // incluidos, apps que abre y productos que quedan bloqueados.
  async entitlements(req: Request, res: Response) {
    try {
      return ok(res, await plansService.entitlements(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ---- Server-to-server (X-Internal-Secret, lo llama pms-core/api) ----

  // El catalogo que ve el hotelero al terminar el alta.
  async publicCatalog(_req: Request, res: Response) {
    const data = await plansService.publicCatalog();
    return ok(res, { data, total: data.length });
  },

  // Los entitlements de un plan, para armar el snapshot que se guarda en la
  // company y para revalidarlo cuando el plan cambia.
  async internalEntitlements(req: Request, res: Response) {
    try {
      return ok(res, await plansService.entitlements(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },
};

/**
 * Los textos de la pantalla `/planes` del PMS.
 *
 * El catalogo de campos viaja junto con lo cargado para que el editor se arme
 * solo: agregar un texto editable es agregar una entrada en `planPageFields.ts`
 * y nada mas.
 */
export const planPageContentController = {
  async get(_req: Request, res: Response) {
    const content = await planPageContentService.getForEditor();
    return ok(res, {
      // Lo cargado va como `values` y no como `locales` para no chocar con la
      // lista de idiomas disponibles, que se llama igual de natural.
      values: content.locales,
      updatedByUserId: content.updatedByUserId,
      version: content.version,
      updatedAt: content.updatedAt,
      fields: PLAN_PAGE_FIELDS,
      groups: PLAN_PAGE_GROUPS,
      locales: PLAN_PAGE_LOCALES.map((code) => ({
        code,
        label: PLAN_PAGE_LOCALE_LABELS[code],
      })),
    });
  },

  async replace(req: Request, res: Response) {
    const { error, value } = replacePlanPageContentSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const saved = await planPageContentService.replace(
        value.locales,
        req.internalUser?.userId ?? "unknown",
      );
      return ok(res, saved);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // Server-to-server: lo pide pms-core junto con el catalogo.
  async internalGet(_req: Request, res: Response) {
    return ok(res, { locales: await planPageContentService.get() });
  },
};

/**
 * El catalogo de planes para el sitio publico de bookfer.
 *
 * Va sin JWT porque lo consume `<PlansMkt/>` desde el renderer del sitio, que
 * lo renderiza para cualquiera que entre. Devuelve MENOS que el catalogo del
 * PMS a proposito: nombre, precio y productos incluidos, que es lo que se
 * publica en una pagina de precios. Las apps y rutas que cada producto habilita
 * son detalle de implementacion del gate del PMS y no tienen por que estar en
 * el HTML de un sitio publico.
 */
export const publicPlansController = {
  async list(_req: Request, res: Response) {
    const plans = await plansService.publicCatalog();
    return ok(res, {
      data: plans.map((p) => ({
        planId: p.planId,
        slug: p.slug,
        name: p.name,
        tagline: p.tagline,
        description: p.description,
        price: p.price,
        free: p.free,
        freeDurationDays: p.freeDurationDays,
        trialDays: p.trialDays,
        limits: p.limits,
        highlighted: p.highlighted,
        order: p.order,
        products: p.products
          .filter((x) => !x.core)
          .map((x) => ({ key: x.key, name: x.name, description: x.description })),
      })),
      total: plans.length,
    });
  },
};

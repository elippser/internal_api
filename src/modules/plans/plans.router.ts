import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import {
  planCreditsController,
  planPageContentController,
  plansController,
  productsController,
  publicPlansController,
} from "./plans.controller";

export const plansRouter = Router();

/* ------- Server-to-server: lo consume pms-core/api -------
   Va ANTES del authenticate: el PMS llama con X-Internal-Secret, no con el
   JWT del panel interno. */
const internal = Router();
internal.use(requireInternalSecret);
internal.get("/catalog", plansController.publicCatalog);
internal.get("/content", planPageContentController.internalGet);
internal.get("/:id/entitlements", plansController.internalEntitlements);
// Gate de creditos de Bookfer IA. Reemplaza al viejo /contracts/credits/check.
internal.post("/credits/check", planCreditsController.check);
plansRouter.use("/internal", internal);

/* ---------------------- Operador interno ---------------------- */
plansRouter.use(authenticate);

// Productos. Van antes de "/:id" de planes para que Express no capture
// "products" como un planId.
plansRouter.get(
  "/products/categories",
  authorize("analyst"),
  productsController.categories,
);
plansRouter.get("/products", authorize("analyst"), productsController.list);
plansRouter.post(
  "/products/seed",
  authorize("admin"),
  productsController.seed,
);
plansRouter.get(
  "/products/:id",
  authorize("analyst"),
  productsController.getOne,
);
// Escritura del catalogo: admin+. Un producto mal definido corta el acceso de
// todas las companies que tengan un plan que lo incluya.
plansRouter.post("/products", authorize("admin"), productsController.create);
plansRouter.patch(
  "/products/:id",
  authorize("admin"),
  productsController.update,
);
plansRouter.delete(
  "/products/:id",
  authorize("admin"),
  productsController.remove,
);

// Textos de la pantalla /planes del PMS. Van antes de "/:id" para que
// "content" no se lea como un planId.
plansRouter.get("/content", authorize("analyst"), planPageContentController.get);
plansRouter.put("/content", authorize("admin"), planPageContentController.replace);

// Creditos de IA de una company. Antes de "/:id" para que "company" no se lea
// como un planId.
plansRouter.get(
  "/company/:companyId/credits",
  authorize("analyst"),
  planCreditsController.companyCredits,
);

// Planes.
plansRouter.get("/", authorize("analyst"), plansController.list);
plansRouter.get(
  "/:id/entitlements",
  authorize("analyst"),
  plansController.entitlements,
);
plansRouter.get("/:id", authorize("analyst"), plansController.getOne);
plansRouter.post("/", authorize("admin"), plansController.create);
plansRouter.patch("/:id", authorize("admin"), plansController.update);
plansRouter.delete("/:id", authorize("admin"), plansController.remove);

/**
 * Superficie publica: la consume el sitio de bookfer. Se monta aparte (fuera de
 * /api/v1) porque no lleva JWT — ver `publicPlansRouter` en index.ts.
 */
export const publicPlansRouter = Router();
publicPlansRouter.get("/", publicPlansController.list);

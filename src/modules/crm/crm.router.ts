import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { crmController } from "./crm.controller";

export const crmRouter = Router();

// ---------- Server-to-server: ingesta de eventos ----------
// Montado ANTES del authenticate: lo llaman pms-core y booking-app con
// X-Internal-Secret, sin JWT de operador.
const internal = Router();
internal.use(requireInternalSecret);
internal.post("/", crmController.ingestEvent);
crmRouter.use("/events/ingest", internal);

// ---------- Operador interno ----------
crmRouter.use(authenticate);

// Rutas fijas ANTES de "/:id" para que no las capture como accountId.
crmRouter.get("/events", authorize("analyst"), crmController.listEvents);
crmRouter.post("/events/drain", authorize("admin"), crmController.drainOutbox);

crmRouter.get("/dashboard", authorize("analyst"), crmController.dashboard);

crmRouter.get("/segments", authorize("analyst"), crmController.listSegments);
crmRouter.post("/segments", authorize("developer"), crmController.createSegment);
crmRouter.get("/segments/:id", authorize("analyst"), crmController.getSegment);
crmRouter.get(
  "/segments/:id/accounts",
  authorize("analyst"),
  crmController.segmentAccounts,
);
crmRouter.patch("/segments/:id", authorize("developer"), crmController.updateSegment);
crmRouter.delete("/segments/:id", authorize("developer"), crmController.deleteSegment);

crmRouter.get("/contacts", authorize("analyst"), crmController.listContacts);
crmRouter.post("/contacts", authorize("developer"), crmController.createContact);
crmRouter.patch("/contacts/:id", authorize("developer"), crmController.updateContact);
crmRouter.delete("/contacts/:id", authorize("admin"), crmController.deleteContact);

// Sincronizacion con el PMS. Escriben muchas cuentas de una: admin+.
crmRouter.post("/sync/backfill", authorize("admin"), crmController.backfill);
crmRouter.post("/sync/stats", authorize("admin"), crmController.refreshStats);

crmRouter.post("/accounts/import", authorize("developer"), crmController.importAccounts);
crmRouter.get("/accounts", authorize("analyst"), crmController.listAccounts);
crmRouter.post("/accounts", authorize("developer"), crmController.createAccount);
crmRouter.get("/accounts/:id", authorize("analyst"), crmController.getAccount);
crmRouter.patch("/accounts/:id", authorize("developer"), crmController.updateAccount);

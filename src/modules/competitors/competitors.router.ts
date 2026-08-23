import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { competitorsController as c } from "./competitors.controller";

/**
 * /api/v1/competitors — inteligencia competitiva (COMPETITIVE-INTEL-SPEC.md §5
 * y -V2.md §10). Lectura y curaduria analyst+; correr el radar/senales y la
 * config developer+; borrado fisico admin+. Las rutas fijas van ANTES de /:id.
 */
export const competitorsRouter = Router();

competitorsRouter.use(authenticate);

// --- Tier 1: listado y agregados --------------------------------------------
competitorsRouter.get("/", authorize("analyst"), c.list);
competitorsRouter.post("/", authorize("analyst"), c.create);
competitorsRouter.get("/summary", authorize("analyst"), c.summary);
competitorsRouter.get("/insights", authorize("analyst"), c.insights);
competitorsRouter.get("/glossary", authorize("analyst"), c.glossary);

// --- Settings -----------------------------------------------------------------
competitorsRouter.get("/settings", authorize("analyst"), c.getSettings);
competitorsRouter.patch("/settings", authorize("developer"), c.patchSettings);

// --- Decisiones --------------------------------------------------------------
competitorsRouter.get("/decisions", authorize("analyst"), c.listDecisions);
competitorsRouter.post("/decisions", authorize("analyst"), c.createDecision);
competitorsRouter.delete("/decisions/:id", authorize("admin"), c.deleteDecision);

// --- Radar (Tier 2) -----------------------------------------------------------
competitorsRouter.get("/radar", authorize("analyst"), c.radarList);
competitorsRouter.get("/radar/runs", authorize("analyst"), c.radarRuns);
competitorsRouter.post("/radar/run", authorize("developer"), c.radarRun);
competitorsRouter.patch("/radar/:id", authorize("analyst"), c.radarAction);

// --- Señales, eventos, sugerencias, menciones (v2) -----------------------------
competitorsRouter.get("/signals/connectors", authorize("analyst"), c.signalsConnectors);
competitorsRouter.post("/signals/run", authorize("developer"), c.signalsRun);
competitorsRouter.get("/signals/events", authorize("analyst"), c.eventsList);
competitorsRouter.patch("/signals/events/:id", authorize("analyst"), c.eventPatch);
competitorsRouter.get("/signals", authorize("analyst"), c.signalsList);
competitorsRouter.get("/suggestions", authorize("analyst"), c.suggestionsList);
competitorsRouter.patch("/suggestions/:id", authorize("analyst"), c.suggestionAction);
competitorsRouter.post("/mentions/scan", authorize("developer"), c.mentionsScan);

// --- Comparador (v2.1) ---------------------------------------------------------
competitorsRouter.get("/compare/options", authorize("analyst"), c.compareOptions);
competitorsRouter.get("/compare", authorize("analyst"), c.compare);

// --- Detalle ------------------------------------------------------------------
competitorsRouter.get("/:id", authorize("analyst"), c.getOne);
competitorsRouter.patch("/:id", authorize("analyst"), c.update);
competitorsRouter.get("/:id/signals", authorize("analyst"), c.competitorSignals);
competitorsRouter.post("/:id/review", authorize("analyst"), c.review);
competitorsRouter.patch("/:id/stage", authorize("analyst"), c.setStage);
competitorsRouter.post("/:id/verify", authorize("analyst"), c.verify);
competitorsRouter.post("/:id/recompute", authorize("analyst"), c.recompute);
competitorsRouter.post("/:id/mentions", authorize("analyst"), c.addMention);
competitorsRouter.delete("/:id/mentions/:mentionId", authorize("analyst"), c.removeMention);
competitorsRouter.post("/:id/evidence", authorize("analyst"), c.addEvidence);
competitorsRouter.delete("/:id/evidence/:evidenceId", authorize("analyst"), c.removeEvidence);
competitorsRouter.post("/:id/weaknesses", authorize("analyst"), c.addWeakness);
competitorsRouter.patch("/:id/weaknesses/:weaknessId", authorize("analyst"), c.updateWeakness);
competitorsRouter.delete("/:id/weaknesses/:weaknessId", authorize("analyst"), c.removeWeakness);
competitorsRouter.post("/:id/social-profiles", authorize("analyst"), c.addSocialProfile);
competitorsRouter.patch("/:id/social-profiles/:profileId", authorize("analyst"), c.updateSocialProfile);
competitorsRouter.delete("/:id/social-profiles/:profileId", authorize("analyst"), c.removeSocialProfile);
competitorsRouter.post("/:id/watched-pages", authorize("analyst"), c.addWatchedPage);
competitorsRouter.patch("/:id/watched-pages/:pageId", authorize("analyst"), c.updateWatchedPage);
competitorsRouter.delete("/:id/watched-pages/:pageId", authorize("analyst"), c.removeWatchedPage);
competitorsRouter.get("/:id/content", authorize("analyst"), c.competitorContent);
competitorsRouter.post("/:id/products", authorize("analyst"), c.addProduct);
competitorsRouter.patch("/:id/products/:productId", authorize("analyst"), c.updateProduct);
competitorsRouter.delete("/:id/products/:productId", authorize("analyst"), c.removeProduct);
competitorsRouter.post("/:id/ads", authorize("analyst"), c.addAd);
competitorsRouter.patch("/:id/ads/:adId", authorize("analyst"), c.updateAd);
competitorsRouter.delete("/:id/ads/:adId", authorize("analyst"), c.removeAd);
competitorsRouter.post("/:id/ai-draft", authorize("analyst"), c.aiDraftRun);
competitorsRouter.post("/:id/ai-draft/apply", authorize("analyst"), c.aiDraftApply);
competitorsRouter.post("/:id/ai-draft/discard", authorize("analyst"), c.aiDraftDiscard);
competitorsRouter.post("/:id/check-changes", authorize("developer"), c.checkChanges);
competitorsRouter.delete("/:id", authorize("admin"), c.remove);

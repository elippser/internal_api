import type { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import { fail, ok } from "../../shared/utils/http";
import { applyDraft, discardDraft, startDraft } from "./aiDraft.service";
import { CiError, competitorsService } from "./competitors.service";
import {
  aiDraftApplySchema,
  aiDraftRunSchema,
  createCompetitorSchema,
  createDecisionSchema,
  evidenceSchema,
  listCompetitorsSchema,
  listRadarSchema,
  mentionSchema,
  radarActionSchema,
  radarRunSchema,
  settingsPatchSchema,
  socialProfilePatchSchema,
  stageSchema,
  socialProfileSchema,
  updateCompetitorSchema,
  verifySchema,
  adPatchSchema,
  adSchema,
  compareSchema,
  listContentSchema,
  productPatchSchema,
  productSchema,
  watchedPagePatchSchema,
  watchedPageSchema,
  weaknessPatchSchema,
  weaknessSchema,
} from "./competitors.validation";
import { compareCompetitors, compareOptions } from "./compare.service";
import { decisionsService } from "./decisions.service";
import { glossaryWithOverrides } from "./glossary";
import { computeInsights } from "./insights.service";
import {
  actOnRadarItem,
  checkCompetitorChanges,
  listRadarItems,
  listRadarRuns,
  runRadar,
} from "./radar/radar.service";
import { getSettings, updateSettings } from "./settings.service";
import {
  eventPatchSchema,
  listEventsSchema,
  listSignalsSchema,
  listSuggestionsSchema,
  signalsRunSchema,
  suggestionActionSchema,
} from "./competitors.validation";
import {
  competitorSignalsSummary,
  connectorsHealth,
  listEvents,
  listSignals,
  patchEvent,
  runSignals,
  triggerProfileCheck,
} from "./signals/signals.service";
import { actOnSuggestion, listSuggestions } from "./signals/suggestions.service";
import { scanMentions } from "./mentions/mentionDetector";

type Handler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Express 4 no atrapa rejections de handlers async. Se envuelve cada uno:
 * CiError → su status/code (+ extra, ej. competitorId en duplicate_domain);
 * cualquier otro → 500 con log.
 */
export function wrap(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof CiError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
        return;
      }
      console.error("[competitors] error no manejado:", err);
      fail(res, 500, err instanceof Error ? err.message : "Error interno");
    }
  };
}

export function validate<T>(schema: ObjectSchema, payload: unknown, res: Response, code: string): T | null {
  const { error, value } = schema.validate(payload, { stripUnknown: true });
  if (error) {
    fail(res, 400, error.message, code);
    return null;
  }
  return value as T;
}

export function userId(req: Request): string | null {
  return req.internalUser?.userId ?? null;
}

export const competitorsController = {
  // --- Tier 1 ---------------------------------------------------------------
  list: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(listCompetitorsSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await competitorsService.list(q));
  }),

  create: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(createCompetitorSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.create(body, userId(req)), 201);
  }),

  summary: wrap(async (_req, res) => ok(res, await competitorsService.summary())),

  insights: wrap(async (_req, res) => ok(res, await computeInsights())),

  glossary: wrap(async (_req, res) => {
    const settings = await getSettings();
    return ok(res, { fields: glossaryWithOverrides(settings.fieldHelp) });
  }),

  getSettings: wrap(async (_req, res) => ok(res, await getSettings())),

  patchSettings: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(settingsPatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await updateSettings(body, userId(req)));
  }),

  listDecisions: wrap(async (_req, res) => ok(res, await decisionsService.list())),

  createDecision: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(createDecisionSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await decisionsService.create(body, userId(req)), 201);
  }),

  deleteDecision: wrap(async (req, res) => ok(res, await decisionsService.remove(req.params.id))),

  // --- Radar ----------------------------------------------------------------
  radarList: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(listRadarSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await listRadarItems(q));
  }),

  radarRuns: wrap(async (_req, res) => ok(res, await listRadarRuns())),

  radarRun: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(radarRunSchema, req.body ?? {}, res, "invalid_body");
    if (!body) return;
    return ok(res, await runRadar({ mode: body.mode, trigger: "manual", userId: userId(req) }));
  }),

  radarAction: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(radarActionSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await actOnRadarItem(req.params.id, body, userId(req)));
  }),

  // --- Señales (v2) ---------------------------------------------------------
  signalsConnectors: wrap(async (_req, res) => ok(res, await connectorsHealth())),

  signalsRun: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(signalsRunSchema, req.body ?? {}, res, "invalid_body");
    if (!body) return;
    return ok(res, await runSignals({ trigger: "manual", userId: userId(req), competitorIds: body.competitorIds, connectors: body.connectors }));
  }),

  signalsList: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(listSignalsSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await listSignals(q));
  }),

  eventsList: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(listEventsSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await listEvents(q));
  }),

  eventPatch: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(eventPatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await patchEvent(req.params.id, body.status));
  }),

  suggestionsList: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(listSuggestionsSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await listSuggestions(q));
  }),

  suggestionAction: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(suggestionActionSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await actOnSuggestion(req.params.id, body.action, userId(req), body.value));
  }),

  mentionsScan: wrap(async (req, res) => ok(res, await scanMentions({ trigger: "manual", userId: userId(req) }))),

  competitorSignals: wrap(async (req, res) => ok(res, await competitorSignalsSummary(req.params.id))),

  // --- Detalle ----------------------------------------------------------------
  getOne: wrap(async (req, res) => {
    const result = await competitorsService.getById(req.params.id);
    if (!result) return fail(res, 404, "Competidor no encontrado", "not_found");
    return ok(res, result);
  }),

  update: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(updateCompetitorSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.update(req.params.id, body, userId(req)));
  }),

  review: wrap(async (req, res) => ok(res, await competitorsService.review(req.params.id, userId(req)))),

  setStage: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(stageSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.setStage(req.params.id, body, userId(req)));
  }),

  verify: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(verifySchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.verify(req.params.id, body.paths, userId(req)));
  }),

  recompute: wrap(async (req, res) => ok(res, await competitorsService.recompute(req.params.id))),

  addMention: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(mentionSchema, req.body ?? {}, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.addMention(req.params.id, body, userId(req)));
  }),

  removeMention: wrap(async (req, res) =>
    ok(res, await competitorsService.removeMention(req.params.id, req.params.mentionId, userId(req))),
  ),

  addEvidence: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(evidenceSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.addEvidence(req.params.id, body, userId(req)));
  }),

  removeEvidence: wrap(async (req, res) =>
    ok(res, await competitorsService.removeEvidence(req.params.id, req.params.evidenceId, userId(req))),
  ),

  addWeakness: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(weaknessSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.addWeakness(req.params.id, body, userId(req)), 201);
  }),

  updateWeakness: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(weaknessPatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.updateWeakness(req.params.id, req.params.weaknessId, body, userId(req)));
  }),

  removeWeakness: wrap(async (req, res) =>
    ok(res, await competitorsService.removeWeakness(req.params.id, req.params.weaknessId, userId(req))),
  ),

  addSocialProfile: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(socialProfileSchema, req.body, res, "invalid_body");
    if (!body) return;
    const updated = await competitorsService.addSocialProfile(req.params.id, body, userId(req));
    // Alta ya confirmada: se mide de una (mismo criterio que confirmar un candidato).
    if ((body.status ?? "confirmed") === "confirmed") triggerProfileCheck(req.params.id, body.network);
    return ok(res, updated, 201);
  }),

  updateSocialProfile: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(socialProfilePatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    const updated = await competitorsService.updateSocialProfile(req.params.id, req.params.profileId, body, userId(req));
    // Confirmar un perfil dispara su primera medición en background (best-effort).
    if (body.status === "confirmed") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile = (updated.socialProfiles as any[])?.find((p) => p.profileId === req.params.profileId);
      if (profile) triggerProfileCheck(req.params.id, profile.network);
    }
    return ok(res, updated);
  }),

  removeSocialProfile: wrap(async (req, res) =>
    ok(res, await competitorsService.removeSocialProfile(req.params.id, req.params.profileId, userId(req))),
  ),

  addWatchedPage: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(watchedPageSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.addWatchedPage(req.params.id, body, userId(req)), 201);
  }),

  updateWatchedPage: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(watchedPagePatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.updateWatchedPage(req.params.id, req.params.pageId, body, userId(req)));
  }),

  removeWatchedPage: wrap(async (req, res) =>
    ok(res, await competitorsService.removeWatchedPage(req.params.id, req.params.pageId, userId(req))),
  ),

  // --- productos, anuncios y contenido (v2.1) --------------------------------
  addProduct: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(productSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.addProduct(req.params.id, body, userId(req)), 201);
  }),

  updateProduct: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(productPatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.updateProduct(req.params.id, req.params.productId, body, userId(req)));
  }),

  removeProduct: wrap(async (req, res) => ok(res, await competitorsService.removeProduct(req.params.id, req.params.productId, userId(req)))),

  addAd: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(adSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.addAd(req.params.id, body, userId(req)), 201);
  }),

  updateAd: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(adPatchSchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await competitorsService.updateAd(req.params.id, req.params.adId, body, userId(req)));
  }),

  removeAd: wrap(async (req, res) => ok(res, await competitorsService.removeAd(req.params.id, req.params.adId, userId(req)))),

  competitorContent: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(listContentSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await competitorsService.content(req.params.id, q));
  }),

  compare: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = validate<any>(compareSchema, req.query, res, "invalid_query");
    if (!q) return;
    return ok(res, await compareCompetitors(q));
  }),

  compareOptions: wrap(async (_req, res) => ok(res, await compareOptions())),

  aiDraftRun: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(aiDraftRunSchema, req.body ?? {}, res, "invalid_body");
    if (!body) return;
    const result = await startDraft(req.params.id, { includeEvidence: body.includeEvidence, userId: userId(req) });
    return ok(res, result, 202);
  }),

  aiDraftApply: wrap(async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = validate<any>(aiDraftApplySchema, req.body, res, "invalid_body");
    if (!body) return;
    return ok(res, await applyDraft(req.params.id, body.fields, userId(req)));
  }),

  aiDraftDiscard: wrap(async (req, res) => ok(res, await discardDraft(req.params.id, userId(req)))),

  checkChanges: wrap(async (req, res) => ok(res, await checkCompetitorChanges(req.params.id, userId(req)))),

  remove: wrap(async (req, res) => ok(res, await competitorsService.remove(req.params.id))),
};

/**
 * Endpoints del estado turístico para el PMS.
 *
 *   GET  /api/v1/tourism/dossier?propertyId=&companyId=&narratives=1&wait=1&fresh=1
 *   POST /api/v1/tourism/dossier/warm   { propertyId, companyId }
 *
 * Mismo portón que el runtime del chat: `X-Internal-Secret` prueba que la
 * llamada viene del PMS y `X-Pms-User-Token` dice QUIÉN la hace. La propiedad
 * se valida contra el alcance real del usuario: nadie lee el dossier de una
 * propiedad ajena por adivinar su id (404, igual que una conversación ajena).
 */

import { Router, type Request, type Response } from "express";
import { fail } from "../../shared/utils/http";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import type { ExperienceLevel } from "../../shared/agentAuth/userScope";
import { requirePmsUser } from "../conversations/conversations.guards";
import { resolveScopeForSession } from "../conversations/services/toolAccess";
import { usageService } from "../usage/usage.service";
import { defaultDossierDeps, getDossier } from "./dossier.service";
import { loadPropertyDoc } from "./location";
import { generateNarratives, narrativesStamp } from "./narratives";
import { buildPanel } from "./panel";
import { TOURISM_HUBS, type StoredNarratives } from "./tourism.types";

export const tourismRouter = Router();

tourismRouter.use(requireInternalSecret);

/** El panel espera un poco más que el chat: el usuario eligió abrirlo. */
const PANEL_WAIT_MS = Number(process.env.TOURISM_PANEL_WAIT_MS ?? 15_000);
const WARM_BUDGET_MS = Number(process.env.TOURISM_WARM_BUDGET_MS ?? 25_000);
/** "Actualizar" ignora el TTL: una vez por minuto por propiedad, como mucho. */
const FRESH_COOLDOWN_MS = 60_000;

const lastFresh = new Map<string, number>();
const narrativeFlights = new Map<string, Promise<StoredNarratives | null>>();

interface Authorized {
  propertyId: string;
  companyId?: string;
  userId: string;
  level: ExperienceLevel;
}

async function authorize(req: Request, res: Response): Promise<Authorized | null> {
  const userId = res.locals.pmsUserId as string;
  const source = { ...(req.query as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
  const propertyId = typeof source.propertyId === "string" ? source.propertyId.trim() : "";
  const companyId = typeof source.companyId === "string" && source.companyId ? source.companyId : undefined;
  if (!propertyId) {
    fail(res, 400, "Falta la propiedad", "property_required");
    return null;
  }

  const [scope, doc] = await Promise.all([
    resolveScopeForSession({ userId, companyId }),
    loadPropertyDoc(propertyId).catch(() => null),
  ]);
  const inScope =
    !!scope &&
    scope.resolved &&
    !!doc &&
    (!scope.companyId || !doc.companyId || doc.companyId === scope.companyId) &&
    (scope.isAdmin || scope.allProperties || scope.propertyIds.includes(propertyId));
  if (!inScope) {
    fail(res, 404, "Propiedad no encontrada", "not_found");
    return null;
  }
  return { propertyId, companyId: scope.companyId ?? companyId, userId, level: scope.experienceLevel ?? "basico" };
}

tourismRouter.get("/dossier", requirePmsUser, async (req: Request, res: Response) => {
  try {
    const auth = await authorize(req, res);
    if (!auth) return;

    let fresh = req.query.fresh === "1";
    if (fresh) {
      const last = lastFresh.get(auth.propertyId) ?? 0;
      if (Date.now() - last < FRESH_COOLDOWN_MS) fresh = false;
      else lastFresh.set(auth.propertyId, Date.now());
    }

    const result = await getDossier({
      propertyId: auth.propertyId,
      hubs: TOURISM_HUBS,
      budgetMs: req.query.wait === "1" ? PANEL_WAIT_MS : 1500,
      fresh,
    });
    if (!result.ok) {
      // Sin ubicación no es un error del servidor: es un dato que falta cargar.
      return res.status(result.reason === "no_location" ? 200 : 404).json({
        ok: false,
        error: { message: result.message, code: result.reason },
        data: result.property ? { property: result.property } : null,
      });
    }
    const dossier = result.dossier;
    const stamp = narrativesStamp(dossier);

    let narratives: StoredNarratives | null =
      dossier.narratives && dossier.narratives.stamp === stamp ? dossier.narratives : null;

    // Se generan sólo con el dossier completo: con hubs todavía leyéndose, la
    // huella cambiaría en un rato y el pedido se tiraría.
    if (req.query.narratives === "1" && !narratives && dossier.meta.pending.length === 0) {
      const key = `${auth.propertyId}:${stamp}`;
      let flight = narrativeFlights.get(key);
      if (!flight) {
        flight = (async () => {
          const generated = await generateNarratives(dossier, auth.level);
          if (!generated) return null;
          const deps = await defaultDossierDeps();
          await deps.store.saveNarratives(auth.propertyId, generated.narratives).catch((err) =>
            console.warn("[tourism] no se pudieron guardar las narrativas:", err instanceof Error ? err.message : err),
          );
          try {
            await usageService.record({
              source: "conversation_agent",
              agentSlug: "tourism-narratives",
              model: generated.narratives.model,
              companyId: auth.companyId ?? "unknown",
              propertyId: auth.propertyId,
              userId: auth.userId,
              inputTokens: generated.inputTokens,
              outputTokens: generated.outputTokens,
              latencyMs: generated.ms,
              toolCallCount: 0,
            });
          } catch (err) {
            console.error("[usage] no se pudo registrar el consumo de las narrativas:", err);
          }
          return generated.narratives;
        })().finally(() => narrativeFlights.delete(key));
        narrativeFlights.set(key, flight);
      }
      narratives = await flight;
    }

    return res.json({ ok: true, data: buildPanel(dossier, narratives?.byFacet ?? null) });
  } catch (err) {
    console.error("[tourism] GET /dossier:", err);
    return fail(res, 500, "No se pudo leer el estado turístico", "tourism_error");
  }
});

/**
 * Precalienta el dossier al abrir el chat, para que la primera pregunta
 * turística encuentre los datos listos. Lee sólo lo vencido.
 */
tourismRouter.post("/dossier/warm", requirePmsUser, async (req: Request, res: Response) => {
  try {
    const auth = await authorize(req, res);
    if (!auth) return;
    const result = await getDossier({ propertyId: auth.propertyId, hubs: TOURISM_HUBS, budgetMs: WARM_BUDGET_MS });
    if (!result.ok) return res.json({ ok: false, reason: result.reason });
    return res.json({
      ok: true,
      data: { computed: result.dossier.meta.computed, pending: result.dossier.meta.pending, ms: result.dossier.meta.ms },
    });
  } catch (err) {
    console.error("[tourism] POST /dossier/warm:", err);
    return fail(res, 500, "No se pudo precalentar el estado turístico", "tourism_error");
  }
});

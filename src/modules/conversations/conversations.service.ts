import { v4 as uuidv4 } from "uuid";
// El agente ya NO se lee de la coleccion vieja: lo resuelve el motor. Ver
// services/agentResolver.ts — deprecar el modulo viejo exigia cortar la
// LECTURA, no solo la escritura, o la consola nueva editaria una copia que el
// chat de produccion nunca ve.
import { resolveAgent } from "./services/agentResolver";
import { FeedbackRequest } from "../feedback/feedback.model";
import {
  ConversationMessage,
  ConversationSession,
  sanitizeMessage,
  sanitizeSession,
} from "./conversations.model";
import { enrichContext } from "./services/pmsContextResolver";
import { retrieve } from "./services/ragRetriever";
import { buildSystemPromptParts } from "./services/promptAssembler";
import { renderSkillsBlock, resolveSkills } from "../../engine/skills/resolver";
import { runTurn, type StepEvent } from "./services/conversationRunner";
import { typedAnswerMatches } from "./services/confirmationPolicy";
import { routeTurn } from "./services/taskRouter";
import { prepareStrategicTurn } from "../growth/strategicTurn";
import {
  STRATEGIC_TOURISM_FACETS,
  TOURISM_ENRICH_NOTE,
  TOURISM_PREP_BUDGET_MS,
  TOURISM_STATUS_BLOCK,
  TOURISM_STEP_LABEL,
  TOURISM_STRATEGIC_BUDGET_MS,
  prepareTourismContext,
  tourismModel,
  tourismProfile,
  tourismSpecialization,
  type TourismMode,
  type TourismTurnContext,
} from "../tourism/tourismTurn";
import {
  getActivePlan,
  markStep,
  renderActivePlanBlock,
} from "../growth/plan/plan.service";
import {
  executeTool,
  ToolExecutionError,
} from "./services/toolExecutor";
import {
  checkToolCall,
  computeTurnToolAccess,
  renderPermissionsBlock,
  resolveScopeForSession,
} from "./services/toolAccess";
import { Tool } from "../tools/tools.model";
import { usageService } from "../usage/usage.service";
import {
  iaEnforcementOn,
  planCreditsService,
} from "../plans/planCredits.service";
import { memoryService } from "../memory/memory.service";
import { modelFor, tierOf } from "../../shared/llm/provider";
import {
  digestMedia,
  formatSeconds,
  type MediaFrame,
} from "./services/mediaDigest.service";

const HISTORY_WINDOW = Number(
  process.env.CONVERSATION_HISTORY_WINDOW ?? 20,
);

interface CreateSessionInput {
  agentId: string;
  context: {
    userId?: string;
    companyId?: string;
    propertyId?: string;
    operativeSpaceId?: string;
    operativeSpaceName?: string;
    userRole?: string;
    channel: "pms_app" | "public_web" | "widget" | "internal";
    // JWT del hotelero. Si esta presente, enrichContext lo verifica y
    // el userId verificado pisa al raw.
    token?: string;
  };
}

interface ListOptions {
  agentId?: string;
  status?: string;
  channel?: string;
  companyId?: string;
  propertyId?: string;
  operativeSpaceId?: string;
  userId?: string;
  hasFeedback?: boolean;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

// Callbacks de streaming del turno (endpoint SSE): status de pasos + texto en
// vivo + cierre del segmento de texto cuando el modelo pasa a una herramienta
// (el texto queda como ítem intermedio de la transcripción, no se descarta).
export interface TurnStreamHandlers {
  onStep?: (e: StepEvent) => void;
  onDelta?: (text: string) => void;
  onTextEnd?: () => void;
  /**
   * Tarjeta armada por el código ANTES de que el modelo escriba (hoy: el estado
   * turístico). El cliente la muestra enseguida y la síntesis se escribe adentro.
   */
  onCard?: (block: { tool: string; result: unknown }) => void;
}

// Adjunto del usuario. Imagen, PDF y texto traen el archivo en `dataB64`.
// Video y audio traen lo que el navegador extrajo (fotogramas + pista de
// sonido) en `media`, y antes del turno se convierten en un informe escrito
// (services/mediaDigest.service.ts): el protocolo del chat no los transporta.
interface MessageAttachment {
  kind: "image" | "document" | "video" | "audio";
  name?: string;
  mediaType: string;
  dataB64: string;
  media?: {
    durationSec?: number | null;
    frames?: MediaFrame[];
    audioWavB64?: string;
    audioSeconds?: number;
  };
}

// Media types que van al modelo como documento de TEXTO (la API solo acepta
// base64 para imágenes y PDF; un CSV base64 daría 400). Todo `text/*` entra
// solo; esta lista es para los formatos de texto que el SO etiqueta como
// `application/*`. El chat del PMS ya normaliza a text/plain o text/csv.
const TEXT_ATTACHMENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/sql",
  "image/svg+xml",
]);

// Tope de caracteres del texto decodificado (~50k tokens). Un CSV grande no
// entra en contexto; preferimos truncar con aviso a que el turno muera.
const TEXT_ATTACHMENT_MAX_CHARS = 200_000;

// Tope del informe de videos/audios que se guarda para los turnos siguientes.
const ATTACHMENT_CONTEXT_MAX_CHARS = 12_000;

function isTextAttachment(a: MessageAttachment): boolean {
  const type = (a.mediaType || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    TEXT_ATTACHMENT_TYPES.has(type) ||
    /\.(csv|tsv|txt|md|json|xml|ya?ml|log)$/i.test(a.name ?? "")
  );
}

// Una imagen o un PDF viajan como bytes al modelo: el turno necesita uno que
// vea. Texto, video y audio llegan como texto (el video ya leído).
function needsVision(attachments: MessageAttachment[]): boolean {
  return attachments.some(
    (a) => a.kind === "image" || (a.kind === "document" && !isTextAttachment(a)),
  );
}

function decodeTextAttachment(a: MessageAttachment): string {
  let text = Buffer.from(a.dataB64, "base64").toString("utf8");
  // BOM de Excel/Windows al exportar CSV.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length > TEXT_ATTACHMENT_MAX_CHARS) {
    text =
      text.slice(0, TEXT_ATTACHMENT_MAX_CHARS) +
      "\n… [archivo truncado por tamaño; esto NO es el final del archivo]";
  }
  return text;
}

export const conversationsService = {
  async createSession(input: CreateSessionInput) {
    const agent = await resolveAgent(input.agentId);
    if (!agent) {
      throw httpError(404, "Agente no encontrado");
    }
    if (agent.status !== "active") {
      throw httpError(409, "El agente no esta activo");
    }
    if (
      agent.deployment.allowedCompanyIds.length > 0 &&
      input.context.companyId &&
      !agent.deployment.allowedCompanyIds.includes(input.context.companyId)
    ) {
      throw httpError(403, "El agente no esta habilitado para esta company");
    }
    if (
      agent.deployment.requiresAuth &&
      !input.context.userId &&
      !input.context.token
    ) {
      throw httpError(401, "El agente requiere usuario autenticado");
    }

    const enriched = await enrichContext(input.context);

    // Si requiresAuth y al final del enrichContext seguimos sin userId
    // verificado (token invalido o no resolvio), bloqueamos: la sesion no
    // puede crear JWTs delegados para tools, asi que no tiene sentido seguir.
    if (agent.deployment.requiresAuth && !enriched.userId) {
      throw httpError(401, "Token de usuario invalido o ausente");
    }

    const session = await ConversationSession.create({
      sessionId: `sess-${uuidv4()}`,
      agentId: input.agentId,
      context: enriched,
      status: "active",
      turnCount: 0,
      feedbackRequestIds: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    });

    return {
      sessionId: session.sessionId,
      agent: {
        agentId: agent.agentId,
        displayName: agent.persona.displayName,
        persona: {
          tone: agent.persona.tone,
          language: agent.persona.language,
        },
      },
    };
  },

  async getSession(sessionId: string) {
    const doc = await ConversationSession.findOne({ sessionId });
    return doc ? sanitizeSession(doc) : null;
  },

  async endSession(sessionId: string) {
    const doc = await ConversationSession.findOneAndUpdate(
      { sessionId, status: "active" },
      { $set: { status: "ended", endedAt: new Date() } },
      { new: true },
    );
    return doc ? sanitizeSession(doc) : null;
  },

  async postMessage(
    sessionId: string,
    content: string,
    attachments: MessageAttachment[] = [],
    stream?: TurnStreamHandlers,
  ) {
    const session = await ConversationSession.findOne({ sessionId });
    if (!session) throw httpError(404, "Sesion no encontrada");
    if (!content.trim() && attachments.length === 0) {
      throw httpError(400, "Falta contenido o adjuntos", "empty_message");
    }

    // Conversaciones reanudables: si la sesion estaba terminada o expirada,
    // el usuario la esta retomando desde el sidebar -> la reactivamos en vez
    // de cortar. (El sessionExpiryJob solo marca expiradas las inactivas; al
    // postear, el usuario esta activo ahora.)
    if (session.status !== "active") {
      session.status = "active";
      session.endedAt = undefined;
    }

    const agent = await resolveAgent(session.agentId);
    if (!agent) throw httpError(404, "Agente no encontrado");

    const limits = agent.limits;
    if (session.turnCount >= (limits.maxTurnsPerSession ?? 50)) {
      throw httpError(429, "La conversacion llego al limite de turnos");
    }

    // Enforcement de creditos de IA (plan de la company). Si no tiene
    // creditos en el periodo, no corremos el turno. credito === token.
    if (iaEnforcementOn()) {
      const credits = await planCreditsService.checkCredits(
        session.context.companyId ?? "",
      );
      if (!credits.allowed) {
        throw httpError(402, credits.message, "ia_credits_exhausted");
      }
    }

    // Titulo del chat (para el sidebar): se autogenera del primer mensaje.
    if (!session.title) {
      session.title =
        content.trim().slice(0, 60) ||
        (attachments.length ? "Archivo adjunto" : "");
    }

    // Videos y audios: el modelo del chat no los recibe, así que antes del
    // turno se leen y se vuelven texto (ver services/mediaDigest.service.ts).
    // Van en paralelo, y uno que no se pudo leer NO tumba el turno: entra como
    // aviso, para que el asistente se lo diga al usuario en vez de contestar
    // como si lo hubiera visto.
    const mediaAttachments = attachments.filter(
      (a) => a.kind === "video" || a.kind === "audio",
    );
    const mediaReports = new Map<MessageAttachment, string>();
    if (mediaAttachments.length) {
      const allVideo = mediaAttachments.every((a) => a.kind === "video");
      const allAudio = mediaAttachments.every((a) => a.kind === "audio");
      stream?.onStep?.({
        kind: "server_tool",
        toolName: "media_digest",
        label: allVideo
          ? mediaAttachments.length > 1
            ? "Mirando los videos…"
            : "Mirando el video…"
          : allAudio
            ? mediaAttachments.length > 1
              ? "Escuchando los audios…"
              : "Escuchando el audio…"
            : "Revisando los archivos…",
      });

      const outcomes = await Promise.all(
        mediaAttachments.map(async (a) => {
          const kind = a.kind as "video" | "audio";
          try {
            const r = await digestMedia({
              kind,
              name: a.name,
              durationSec: a.media?.durationSec ?? undefined,
              frames: a.media?.frames,
              audioWavB64: a.media?.audioWavB64 || undefined,
              audioSeconds: a.media?.audioSeconds,
              userText: content,
            });
            return { a, kind, r, error: null as string | null };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.warn(`[conversations] no se pudo leer el ${kind} "${a.name}": ${error}`);
            return { a, kind, r: null, error };
          }
        }),
      );

      let digestIn = 0;
      let digestOut = 0;
      let digestMs = 0;
      let digestModel = "";
      for (const o of outcomes) {
        const label = `${o.kind === "video" ? "el video" : "el audio"} "${o.a.name || o.kind}"`;
        if (o.r) {
          digestIn += o.r.inputTokens;
          digestOut += o.r.outputTokens;
          digestMs += o.r.ms;
          digestModel = o.r.model;
          mediaReports.set(
            o.a,
            `Lectura de ${label} (dura ${formatSeconds(o.a.media?.durationSec ?? undefined)}). ` +
              `La hizo otro modelo que ve y escucha: vos no tenés el archivo, sólo este informe.\n\n${o.r.text}`,
          );
        } else {
          mediaReports.set(
            o.a,
            `El usuario adjuntó ${label}, pero no se pudo leer (${o.error}). ` +
              "Decile que no pudiste verlo y pedile que lo intente de nuevo o que cuente qué muestra.",
          );
        }
      }

      // Consumo de la lectura: es un llamado aparte, con su propio modelo y
      // precio. Mismo criterio que el del turno: nunca rompe el turno.
      if (digestModel) {
        try {
          await usageService.record({
            source: "conversation_agent",
            agentId: agent.agentId,
            agentSlug: agent.slug,
            model: digestModel,
            companyId: session.context.companyId ?? "unknown",
            propertyId: session.context.propertyId ?? null,
            userId: session.context.userId ?? null,
            userRole: session.context.userRole ?? null,
            conversationId: session.sessionId,
            sessionId: session.sessionId,
            turnIndex: session.turnCount + 1,
            inputTokens: digestIn,
            outputTokens: digestOut,
            latencyMs: digestMs,
            toolCallCount: 0,
            occurredAt: new Date(),
          });
        } catch (err) {
          console.error("[usage] no se pudo registrar la lectura de adjuntos:", err);
        }
      }
    }

    // Persistir mensaje del usuario. NO guardamos el base64 de los adjuntos
    // (pesado): dejamos el texto, o una nota si solo hubo archivos. De los
    // videos y audios sí queda el informe, para los turnos siguientes.
    const persistedUserText =
      content.trim() ||
      (attachments.length
        ? `[${attachments.length} archivo(s) adjunto(s)]`
        : "");
    await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId: session.sessionId,
      agentId: session.agentId,
      role: "user",
      content: persistedUserText,
      attachmentContext: [...mediaReports.values()]
        .join("\n\n---\n\n")
        .slice(0, ATTACHMENT_CONTEXT_MAX_CHARS),
      createdAt: new Date(),
    });

    // RAG
    const chunks = await retrieve(content, agent.knowledgeBaseIds);
    const ragChunksMeta = chunks.map((c) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      knowledgeBaseId: c.knowledgeBaseId,
      score: c.score,
    }));

    // Memoria de largo plazo del espacio operativo (estilo Claude).
    const memories = session.context.operativeSpaceId
      ? await memoryService.forPrompt(session.context.operativeSpaceId)
      : [];

    // Habilidades (§19): el prompt lleva sólo el NIVEL 1 (una línea por
    // habilidad) y el cuerpo se carga con `load_skill` cuando el modelo lo
    // decide. Los agentes que todavía resuelven de la colección vieja no tienen
    // habilidades declaradas; ahí `declared` vacío significaría "todas las del
    // ámbito", así que la revelación progresiva queda apagada para ellos.
    const skills =
      agent.skillNames.length > 0
        ? await resolveSkills({
            tenantId: null,
            agentId: agent.agentId,
            userId: session.context.userId ?? null,
            declared: agent.skillNames,
          })
        : [];

    // Alcance del usuario (rol, capabilities, apps del espacio, propiedades),
    // resuelto FRESCO contra el PMS en cada turno: revocar un permiso surte
    // efecto en el turno siguiente. De acá salen (1) las tools que se le
    // ofrecen al modelo — las que el usuario no puede usar no se ofrecen —,
    // (2) la sección "Permisos" del prompt y (3) la validación de cada tool
    // call en el runner. Sin usuario verificado (agentes públicos) no hay
    // política: manda el PMS con lo que la tool declare.
    const scope = await resolveScopeForSession({
      userId: session.context.userId ?? undefined,
      companyId: session.context.companyId ?? undefined,
    });
    const access = scope
      ? await computeTurnToolAccess(agent.enabledToolIds, scope)
      : { allowedToolIds: agent.enabledToolIds, denied: [], appAccess: [] };
    const permissionsBlock = scope
      ? renderPermissionsBlock(scope, access, {
          propertyId: session.context.propertyId ?? undefined,
          propertyName: session.context.propertyName ?? undefined,
          operativeSpaceName: session.context.operativeSpaceName ?? undefined,
        })
      : "";
    if (scope && access.denied.length) {
      console.log(
        `[conversations] permisos: ${access.allowedToolIds.length} tools ofrecidas, ${access.denied.length} filtradas para ${scope.role ?? "sin-rol"} (${session.context.userId})`,
      );
    }

    // Prompt partido: prefijo estable (cacheable) + cola dinámica (volátil).
    const { static: systemStatic, dynamic: systemDynamic } =
      buildSystemPromptParts(
        // El listado de tools de la sección 5 se arma con las EFECTIVAS del
        // usuario, no con todo el catálogo del agente.
        { ...(agent as any), enabledToolIds: access.allowedToolIds },
        session as any,
        chunks,
        memories,
        renderSkillsBlock(skills),
        permissionsBlock,
      );

    // Historial: ultimos N mensajes (excepto el recien creado)
    const history = await buildHistoryWindow(session.sessionId);

    // Router de sub-agentes: clasifica la tarea y elige modelo + alcance de
    // tools + especializacion para este turno (dentro del mismo chat).
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant");
    // El plan activo del espacio cumple dos funciones distintas en el turno:
    // (1) el router lo necesita para entender "hacé el paso 2", y (2) su bloque
    // va al prompt de TODOS los turnos, no sólo los estratégicos — porque el
    // usuario va a escribir "¿cómo venimos?" en medio de una charla operativa.
    const activePlan = await getActivePlan({
      operativeSpaceId: session.context.operativeSpaceId ?? undefined,
      propertyId: session.context.propertyId ?? undefined,
    });

    const route = await routeTurn({
      userMessage: content,
      recentContext:
        typeof lastAssistant?.content === "string"
          ? lastAssistant.content.slice(0, 300)
          : undefined,
      // Sólo las tools que el usuario puede usar entran al turno.
      enabledToolIds: access.allowedToolIds,
      hasActivePlan: !!activePlan,
    });

    // ── Turno estratégico ────────────────────────────────────────────────────
    //
    // Objetivo de negocio abierto: en vez de soltar al modelo con 357 tools
    // para que descubra el estado del hotel de a una llamada por vez, se le
    // entrega la foto ya resuelta, las estrategias que aplican y el índice de
    // palancas que puede proponer. Si la preparación falla (no se pudo leer la
    // propiedad), se sigue con el turno normal: peor respuesta, pero respuesta.
    // ── Estado turístico ─────────────────────────────────────────────────────
    //
    // Los hubs de /global corren en este mismo proceso: el dossier de la
    // propiedad se arma en código y arranca YA, en paralelo con la foto del
    // turno estratégico si también hay que armarla.
    //   profile   — la pregunta es sólo contexto: perfil turístico (sin tools).
    //   enriched  — contexto + análisis u operación: turno normal con el dossier.
    //   strategic — objetivo abierto: el dossier es un insumo más del plan.
    const tourismPropertyId = session.context.propertyId ?? null;
    const experience = scope?.experienceLevel ?? "basico";
    const tourismMode: Exclude<TourismMode, "tool"> | null = !tourismPropertyId
      ? null
      : route.strategicRequest
        ? "strategic"
        : route.tourism
          ? route.subAgent.id === "consulta" && attachments.length === 0
            ? "profile"
            : "enriched"
          : null;
    if (tourismMode === "profile") {
      stream?.onStep?.({ kind: "tool_start", toolName: TOURISM_STATUS_BLOCK, label: TOURISM_STEP_LABEL });
    }
    const tourismPromise: Promise<TourismTurnContext | null> =
      tourismMode && tourismPropertyId
        ? prepareTourismContext({
            propertyId: tourismPropertyId,
            facets: route.tourism?.facets ?? STRATEGIC_TOURISM_FACETS,
            mode: tourismMode,
            message: content,
            level: experience,
            budgetMs: tourismMode === "strategic" ? TOURISM_STRATEGIC_BUDGET_MS : TOURISM_PREP_BUDGET_MS,
          }).catch((err) => {
            console.warn(
              "[conversations] no se pudo preparar el estado turístico; sigo sin él:",
              err instanceof Error ? err.message : err,
            );
            return null;
          })
        : Promise.resolve(null);

    let strategic: Awaited<ReturnType<typeof prepareStrategicTurn>> = null;
    if (route.strategicRequest && session.context.propertyId) {
      try {
        strategic = await prepareStrategicTurn({
          propertyId: session.context.propertyId,
          companyId: session.context.companyId ?? undefined,
          operativeSpaceId: session.context.operativeSpaceId ?? undefined,
          userId: session.context.userId ?? undefined,
          agentId: agent.agentId,
          sessionId: session.sessionId,
          scope,
          allowedToolIds: access.allowedToolIds,
          routedModel: route.subAgent.model,
        });
        if (strategic) {
          console.log(
            `[conversations] turno estratégico: foto en ${strategic.meta.snapshotMs}ms, ` +
            `${strategic.meta.playbookIds.length} playbooks (${strategic.meta.playbookIds.join(", ") || "ninguno"}), ` +
            `${strategic.meta.leverCount} palancas` +
            (strategic.meta.missing.length ? `, sin datos: ${strategic.meta.missing.join(", ")}` : ""),
          );
        }
      } catch (err) {
        console.warn(
          "[conversations] no se pudo preparar el turno estratégico; sigo con el normal:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const tourism = await tourismPromise;
    if (tourismMode === "profile") {
      stream?.onStep?.({
        kind: "tool_done",
        toolName: TOURISM_STATUS_BLOCK,
        label: TOURISM_STEP_LABEL,
        status: tourism ? "ok" : "error",
      });
    }
    // La tarjeta sale antes de que el modelo empiece: el usuario ve las cifras
    // mientras se escribe la interpretación.
    if (tourism?.card) {
      stream?.onCard?.({ tool: TOURISM_STATUS_BLOCK, result: tourism.card });
    }
    const tourismProfileTurn = tourismMode === "profile" && tourism !== null && !strategic;
    if (tourism) {
      console.log(
        `[conversations] estado turístico (${tourism.mode}): ${tourism.meta.prepMs}ms, ` +
          `tarjeta ${tourism.card ? `${tourism.card.metrics.length} métricas` : "no"}` +
          (tourism.meta.hubsCold.length ? `, leídos: ${tourism.meta.hubsCold.join(", ")}` : "") +
          (tourism.meta.failure ? `, falla: ${tourism.meta.failure}` : "") +
          (tourism.meta.otherPlace ? `, otro lugar: ${tourism.meta.otherPlace}` : ""),
      );
    }

    // Contenido real para el modelo: adjuntos + texto. Imagen/PDF van inline
    // en base64; CSV/texto se decodifica y va como document de texto plano.
    // Si no hay adjuntos, va el string plano.
    const userBlocks: Array<Record<string, unknown>> = [];
    for (const a of attachments) {
      if (a.kind === "video" || a.kind === "audio") {
        userBlocks.push({
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: mediaReports.get(a) ?? "",
          },
          title: a.name || a.kind,
        });
      } else if (a.kind === "document" && isTextAttachment(a)) {
        userBlocks.push({
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: decodeTextAttachment(a),
          },
          title: a.name || "archivo.csv",
        });
      } else {
        userBlocks.push({
          type: a.kind === "image" ? "image" : "document",
          source: { type: "base64", media_type: a.mediaType, data: a.dataB64 },
        });
      }
    }
    if (content.trim()) userBlocks.push({ type: "text", text: content });
    const userContent: unknown = userBlocks.length ? userBlocks : content;

    // Un turno con imagen o PDF necesita un modelo que vea. El tier barato no
    // ve: OpenRouter contesta 404 "No endpoints found that support image
    // input" (medido el 13-09-2026) y el turno entero muere. Pasaba con
    // "hola" + una foto, que el router manda a consulta, el sub-agente barato.
    let turnModel = strategic?.model ?? (tourismProfileTurn ? tourismModel() : route.subAgent.model);
    if (needsVision(attachments) && tierOf(turnModel) === "cheap") {
      turnModel = modelFor("standard");
    }

    // El bloque del plan activo va en TODOS los turnos (el estratégico ya lo
    // incluye en el suyo, con los deltas de KPI calculados contra la foto
    // fresca). Sin esto, "hacé el paso 2" en una charla operativa no tiene a
    // qué referirse.
    const planBlock =
      activePlan && !strategic ? renderActivePlanBlock(activePlan) : "";

    const tourismDynamic = tourism?.block
      ? tourismProfileTurn
        ? tourism.block
        : `${tourism.block}\n${TOURISM_ENRICH_NOTE}`
      : "";

    const effectiveDynamic = [systemDynamic, planBlock, strategic?.dynamicBlock, tourismDynamic]
      .filter((s) => s && s.trim())
      .join("\n\n---\n\n");
    const effectiveStatic = [systemStatic, strategic?.staticBlock]
      .filter((s) => s && s.trim())
      .join("\n\n---\n\n");

    // Pipeline
    const result = await runTurn({
      session: session as any,
      agent: agent as any,
      systemStatic: effectiveStatic,
      systemDynamic: effectiveDynamic,
      history,
      userMessage: content,
      userContent,
      ragChunksUsed: ragChunksMeta,
      model: turnModel,
      // El perfil turístico no lleva tools ni web: todo lo que necesita ya está
      // en el prompt, y sin definiciones de tools el pedido pesa una fracción.
      toolIds: strategic?.toolIds ?? (tourismProfileTurn ? [] : route.toolIds),
      specialization:
        strategic?.specialization ??
        (tourismProfileTurn && tourism
          ? tourismSpecialization(tourism, experience)
          : route.subAgent.specialization),
      webSearch: tourismProfileTurn ? false : route.subAgent.webSearch,
      codeExec: tourismProfileTurn ? false : route.subAgent.codeExec,
      // En el turno estratégico las habilidades no se ofrecen: el procedimiento
      // que necesita ya vino en los playbooks, y `load_skill` sólo gastaría una
      // de las tres iteraciones.
      hasSkills: !strategic && !tourismProfileTurn && skills.length > 0,
      attachments,
      scope,
      profile: strategic?.profile ?? (tourismProfileTurn ? tourismProfile() : undefined),
      planContext: strategic?.planContext,
      strategicMeta: strategic?.meta,
      tourismContext: tourism ?? undefined,
      // Turnos normales con propiedad y usuario verificado: el modelo puede
      // pedir el estado turístico en vez de buscarlo en la web.
      tourismTool:
        scope && tourismPropertyId && !tourism
          ? { propertyId: tourismPropertyId, level: experience }
          : undefined,
      onStep: stream?.onStep,
      onDelta: stream?.onDelta,
      onTextEnd: stream?.onTextEnd,
    });

    // Persistir respuesta del assistant
    const assistantMsg = await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId: session.sessionId,
      agentId: session.agentId,
      role: "assistant",
      content: result.content,
      agentMeta: {
        ragChunksUsed: result.ragChunksUsed,
        toolsExecuted: result.toolsExecuted,
        trace: result.trace,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        generatedFiles: result.generatedFiles,
        webSources: result.webSources,
        latencyMs: result.latencyMs,
        modelUsed: result.modelUsed,
        stopReason: result.stopReason,
        subAgent: route.subAgent.id,
        subAgentLabel: route.subAgent.label,
        routedTier: route.subAgent.tier,
        strategic: result.strategic,
        tourism: result.tourism,
      },
      createdAt: new Date(),
    });

    // Si el turno ejecutó una tool que era un paso del plan activo, el paso
    // queda marcado. Se hace acá y no en el runner porque recién ahora existe
    // el messageId, que es lo que permite volver al punto del hilo donde se
    // hizo. Es best-effort: un plan desactualizado no puede romper el turno.
    if (activePlan && result.toolsExecuted.length > 0) {
      void markExecutedPlanSteps(activePlan, result.toolsExecuted, assistantMsg.messageId);
    }

    // Si hubo capture_feedback_request exitoso -> completar agentResponse
    const feedbackCalls = result.toolsExecuted.filter(
      (t) =>
        t.toolName === "capture_feedback_request" && t.outcome === "success",
    );
    for (const call of feedbackCalls) {
      const fbId =
        (call.result as { feedbackId?: string } | undefined)?.feedbackId;
      if (fbId) {
        await FeedbackRequest.updateOne(
          { feedbackId: fbId },
          { $set: { agentResponse: result.content } },
        );
      }
    }

    // Actualizar sesion
    session.turnCount += 1;
    session.lastActivityAt = new Date();
    session.totalInputTokens += result.inputTokens;
    session.totalOutputTokens += result.outputTokens;
    await session.save();

    // Medicion de consumo. NUNCA debe romper el turno: si el registro falla,
    // logueamos y seguimos. El agente del editor reporta su propio consumo
    // desde pms-core/api; aca cubrimos los agentes de conversacion del internal.
    try {
      await usageService.record({
        source: "conversation_agent",
        agentId: agent.agentId,
        agentSlug: agent.slug,
        model: result.modelUsed,
        companyId: session.context.companyId ?? "unknown",
        propertyId: session.context.propertyId ?? null,
        userId: session.context.userId ?? null,
        userRole: session.context.userRole ?? null,
        conversationId: session.sessionId,
        sessionId: session.sessionId,
        turnIndex: session.turnCount,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        toolCallCount: result.toolsExecuted.length,
        occurredAt: new Date(),
      });
    } catch (err) {
      console.error("[usage] no se pudo registrar consumo del agente:", err);
    }

    // Memoria de largo plazo: destilamos hechos durables del intercambio de
    // forma ASINCRONA (fire-and-forget). Nunca bloquea la respuesta al usuario.
    if (session.context.operativeSpaceId) {
      void memoryService.distillFromExchange({
        scope: {
          operativeSpaceId: session.context.operativeSpaceId,
          companyId: session.context.companyId,
          propertyId: session.context.propertyId,
          agentId: session.agentId,
        },
        userMessage: content,
        assistantMessage: result.content,
        sourceSessionId: session.sessionId,
        createdByUserId: session.context.userId,
      });
    }

    return { message: sanitizeMessage(assistantMsg) };
  },

  // Descarga un archivo generado por la IA (code_execution) desde la Files API
  // de Anthropic. El SDK 0.27.x no expone la Files API, así que pegamos al REST
  // con el beta header. Devuelve el binario + nombre/mime para el navegador.
  //
  // Desde la migración a OpenRouter esta ruta sólo sirve ids VIEJOS: la server
  // tool code_execution no sobrevive el pasaje por el gateway (400 "Invalid
  // Anthropic Messages API request"), así que no se generan archivos nuevos.
  // Sigue en pie para que un file_id ya guardado en una conversación se pueda
  // descargar mientras quede la clave de Anthropic; sin ella, el error dice por
  // qué en vez de un 500 mudo.
  async fetchGeneratedFile(fileId: string) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw httpError(
        410,
        "Los archivos generados vivían en la Files API de Anthropic y ya no hay clave " +
          "configurada. La generación de archivos está deshabilitada desde la migración a OpenRouter.",
      );
    }
    const headers = {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    };
    const base = "https://api.anthropic.com/v1/files";
    const id = encodeURIComponent(fileId);

    let filename = "archivo";
    let contentType = "application/octet-stream";
    try {
      const metaRes = await fetch(`${base}/${id}`, { headers });
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as {
          filename?: string;
          mime_type?: string;
        };
        if (meta.filename) filename = meta.filename;
        if (meta.mime_type) contentType = meta.mime_type;
      }
    } catch {
      /* metadata best-effort */
    }

    const contentRes = await fetch(`${base}/${id}/content`, { headers });
    if (!contentRes.ok) {
      throw httpError(
        contentRes.status || 502,
        "No se pudo descargar el archivo",
        "file_download_failed",
      );
    }
    const buffer = Buffer.from(await contentRes.arrayBuffer());
    return { buffer, filename, contentType };
  },

  // Créditos de IA de la company (bolsa mensual de tokens): consumido vs total.
  // Es lo que el sidebar del chat muestra como "uso / restante".
  async getCredits(companyId: string | undefined) {
    const credits = await planCreditsService.getCompanyCredits(companyId ?? "");
    return { ...credits, enforcement: iaEnforcementOn() };
  },

  async listMessages(sessionId: string) {
    const docs = await ConversationMessage.find({ sessionId }).sort({
      createdAt: 1,
    });
    return docs.map(sanitizeMessage);
  },

  /**
   * Ejecuta una accion disparada desde una card del chat (UI generativa
   * accionable). NO pasa por el LLM: ejecuta la tool directo con el contexto de
   * la sesion (mintea el JWT delegado -> authz real del PMS). La confirmacion la
   * hace la UI (modal). Persiste un mensaje "assistant" con el resultado para
   * que quede en el hilo y se re-renderice al retomar.
   */
  async executeAction(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    confirm: { confirmationId?: string; confirmText?: string } = {},
  ) {
    const session = await ConversationSession.findOne({ sessionId });
    if (!session) throw httpError(404, "Sesion no encontrada");

    // Dos caminos llegan acá:
    //   (1) las cards accionables de siempre (ACTIONABLE_TOOLS), que el usuario
    //       dispara desde el chat sin pasar por el modelo;
    //   (2) la TARJETA DE CONFIRMACIÓN que emitió el runner al frenar un borrado
    //       o una acción irreversible. Ese camino no usa lista blanca: usa la
    //       confirmación pendiente que el propio runtime guardó, y exige que
    //       coincida el id, la tool y los argumentos exactos. Así el botón no
    //       se puede usar para ejecutar otra cosa que la que se mostró.
    if (confirm.confirmationId) {
      const pending = session.pendingConfirmation as any;
      if (!pending?.confirmationId) {
        throw httpError(409, "No hay ninguna acción esperando confirmación.", "no_pending_confirmation");
      }
      if (pending.confirmationId !== confirm.confirmationId) {
        throw httpError(409, "Esta confirmación ya no es la vigente.", "stale_confirmation");
      }
      if (pending.toolName !== toolName) {
        throw httpError(409, "La acción confirmada no coincide con la pendiente.", "confirmation_mismatch");
      }
      if (pending.expiresAt && new Date(pending.expiresAt).getTime() < Date.now()) {
        session.pendingConfirmation = null;
        await session.save();
        throw httpError(410, "La confirmación venció. Pedile la acción de nuevo al asistente.", "confirmation_expired");
      }
      if (JSON.stringify(pending.inputArgs ?? {}) !== JSON.stringify(args ?? {})) {
        throw httpError(409, "Los datos de la acción cambiaron desde que se pidió la confirmación.", "confirmation_args_mismatch");
      }
      if (pending.level === "typed" && !typedAnswerMatches(pending.subjectValue, confirm.confirmText)) {
        throw httpError(
          400,
          `Para confirmar esta acción hay que escribir exactamente "${pending.subjectValue}".`,
          "confirmation_text_mismatch",
        );
      }
      // Consumida: una confirmación sirve para UNA ejecución.
      session.pendingConfirmation = null;
      await session.save();
    } else if (!ACTIONABLE_TOOLS.has(toolName)) {
      throw httpError(403, "Accion no permitida", "action_not_allowed");
    }

    const agent = await resolveAgent(session.agentId);
    const tool = await Tool.findOne({ name: toolName, status: "active" });
    if (!tool || !agent || !agent.enabledToolIds.includes(tool.toolId)) {
      throw httpError(400, "Herramienta no disponible", "tool_unavailable");
    }

    const ctx = {
      propertyId: session.context.propertyId ?? undefined,
      companyId: session.context.companyId ?? undefined,
      userId: session.context.userId ?? undefined,
      agentId: session.agentId,
      sessionId: session.sessionId,
    };

    // Misma política que el runner: la acción de la card no pasa por el modelo
    // pero SÍ por el alcance del usuario (rol/capability/app/propiedad).
    const scope = await resolveScopeForSession({
      userId: ctx.userId,
      companyId: ctx.companyId,
    });
    if (scope) {
      const decision = checkToolCall(tool as any, args, scope, ctx);
      if (!decision.allowed) {
        throw httpError(
          403,
          decision.message ?? "No tenés permisos para esta acción.",
          decision.code ?? "insufficient_permissions",
        );
      }
    }

    let result: unknown;
    try {
      result = await executeTool(toolName, args, ctx);
    } catch (err) {
      if (err instanceof ToolExecutionError) {
        throw httpError(
          err.status || 400,
          actionErrorMessage(err),
          err.kind || "tool_error",
        );
      }
      throw err;
    }

    const summary = actionSummary(toolName, args, result, tool.displayName ?? undefined);
    const msg = await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId: session.sessionId,
      agentId: session.agentId,
      role: "assistant",
      content: summary,
      agentMeta: {
        ragChunksUsed: [],
        toolsExecuted: [
          {
            toolId: tool.toolId,
            toolName,
            inputArgs: args,
            outcome: "success",
            result,
            durationMs: 0,
            retried: false,
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        modelUsed: "",
        stopReason: "action",
      },
      createdAt: new Date(),
    });

    session.lastActivityAt = new Date();
    await session.save();

    return { message: sanitizeMessage(msg), result };
  },

  // Retroalimentacion explicita del usuario sobre una respuesta del agente.
  async rateMessage(
    sessionId: string,
    messageId: string,
    rating: "up" | "down" | null,
    comment?: string,
    byUserId?: string,
  ) {
    const doc = await ConversationMessage.findOneAndUpdate(
      { messageId, sessionId, role: "assistant" },
      // `rating: null` es "quitar el voto": se borra el subdocumento entero en
      // vez de dejarlo con rating vacío, así las agregaciones pueden seguir
      // preguntando por `feedback.rating` existente sin casos raros.
      rating === null
        ? { $unset: { feedback: "" } }
        : {
            $set: {
              feedback: {
                rating,
                comment: comment ?? "",
                byUserId: byUserId ?? null,
                at: new Date(),
              },
            },
          },
      { new: true },
    );
    if (!doc) throw httpError(404, "Mensaje no encontrado");
    return sanitizeMessage(doc);
  },

  async list(opts: ListOptions) {
    const filter: Record<string, unknown> = {};
    if (opts.agentId) filter.agentId = opts.agentId;
    if (opts.status) filter.status = opts.status;
    if (opts.channel) filter["context.channel"] = opts.channel;
    if (opts.companyId) filter["context.companyId"] = opts.companyId;
    if (opts.propertyId) filter["context.propertyId"] = opts.propertyId;
    if (opts.operativeSpaceId) {
      filter["context.operativeSpaceId"] = opts.operativeSpaceId;
    }
    // Conversaciones privadas por usuario: el sidebar del PMS siempre llega
    // con este filtro (lo fuerza requirePmsUser), asi que nadie ve los chats
    // de un companero de espacio. El audit lo omite y ve todo.
    if (opts.userId) filter["context.userId"] = opts.userId;
    if (opts.hasFeedback) {
      filter.feedbackRequestIds = { $exists: true, $not: { $size: 0 } };
    }
    if (opts.dateFrom || opts.dateTo) {
      const range: Record<string, Date> = {};
      if (opts.dateFrom) range.$gte = new Date(opts.dateFrom);
      if (opts.dateTo) range.$lte = new Date(opts.dateTo);
      filter.startedAt = range;
    }

    const skip = (opts.page - 1) * opts.limit;
    const [docs, total] = await Promise.all([
      ConversationSession.find(filter)
        .sort({ lastActivityAt: -1 })
        .skip(skip)
        .limit(opts.limit),
      ConversationSession.countDocuments(filter),
    ]);

    // Populate agent display name + messageCount + duration
    const sessions = docs.map(sanitizeSession);
    const agentIds = [...new Set(sessions.map((s) => s.agentId))];
    // Los nombres para mostrar tambien salen del motor: si alguien renombra un
    // agente en la consola nueva, el historial de conversaciones tiene que
    // reflejarlo en vez de mostrar el nombre congelado de la coleccion vieja.
    const resolved = await Promise.all(agentIds.map((id) => resolveAgent(id)));
    const agentMap = new Map(
      resolved
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a.agentId, a.persona.displayName || a.name]),
    );

    const sessionIds = sessions.map((s) => s.sessionId);
    const counts = await ConversationMessage.aggregate([
      { $match: { sessionId: { $in: sessionIds } } },
      { $group: { _id: "$sessionId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    return {
      data: sessions.map((s) => ({
        ...s,
        agentName: agentMap.get(s.agentId) ?? s.agentId,
        messageCount: countMap.get(s.sessionId) ?? 0,
        durationSeconds: s.endedAt
          ? Math.round(
            (new Date(s.endedAt).getTime() -
              new Date(s.startedAt).getTime()) /
            1000,
          )
          : null,
        feedbackCount: (s.feedbackRequestIds ?? []).length,
      })),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  },
};

/**
 * Marca como ejecutados los pasos del plan cuya tool corrió en este turno.
 *
 * Se mira lo que REALMENTE se ejecutó (`toolsExecuted`), no lo que el modelo
 * dijo que iba a hacer: el plan es un registro de hechos, y un paso que se
 * marca solo porque el agente lo anunció convierte el seguimiento en ficción.
 *
 * Un paso puede fallar. Ahí queda `fallido` con el código del error, para que
 * el turno siguiente pueda decir "el paso 3 falló por permisos" en vez de
 * volver a proponerlo como si nada.
 */
async function markExecutedPlanSteps(
  plan: { planId: string; steps: Array<{ stepId: string; tool: string; status: string }> },
  executed: Array<{ toolName: string; outcome: string; errorMessage?: string }>,
  messageId: string,
): Promise<void> {
  try {
    const pending = plan.steps.filter(
      (s) => s.status === "sugerido" || s.status === "aceptado",
    );
    for (const step of pending) {
      const hit = executed.find((e) => e.toolName === step.tool);
      if (!hit) continue;
      await markStep({
        planId: plan.planId,
        stepId: step.stepId,
        status: hit.outcome === "success" ? "ejecutado" : "fallido",
        messageId,
        resultSummary:
          hit.outcome === "success" ? `Ejecutado desde el chat.` : undefined,
        errorCode: hit.outcome === "success" ? undefined : hit.errorMessage,
      });
    }
  } catch (err) {
    console.warn(
      "[conversations] no se pudo marcar el paso del plan:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function buildHistoryWindow(sessionId: string) {
  const lastN = await ConversationMessage.find({ sessionId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_WINDOW);
  const ordered = lastN.reverse();

  // Mapeamos a formato Anthropic. Solo persistimos texto plano de tools
  // ejecutadas; los tool_use/tool_result detallados del turno previo no
  // se replican (sesion-larga = costo + complejidad sin beneficio claro).
  // Los videos y audios de mensajes anteriores vuelven como su informe
  // escrito: sin esto, "¿y qué más se veía?" no tiene de dónde contestar.
  return ordered.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content:
      m.role === "user" && m.attachmentContext
        ? `${m.content}\n\n${m.attachmentContext}`
        : m.content,
  }));
}

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

// Tools que la UI puede disparar como accion directa (con confirmacion en el
// modal). Allowlist acotada a propósito: evita que el front ejecute cualquier
// write arbitrario.
const ACTIONABLE_TOOLS = new Set([
  "change_room_status",
  "create_reservation",
  "update_reservation_status",
  // Revenue: resolver la bandeja de recomendaciones desde las tarjetas del chat.
  // Son las dos unicas escrituras del RMS que se ejecutan sin pasar por el
  // modelo — el resto (reglas, guardrails, comp-set) exige criterio y sigue
  // yendo por el turno del agente.
  "accept_rate_recommendation",
  "reject_rate_recommendation",
]);

function actionSummary(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  displayName?: string,
): string {
  const r = (result ?? {}) as Record<string, any>;
  switch (toolName) {
    case "change_room_status":
      return `✅ Habitación actualizada a "${args.status}".`;
    case "create_reservation": {
      const code = r.code ?? r.reservationCode ?? r.reservationId ?? r._id;
      return `✅ Reserva creada${code ? ` (${code})` : ""}.`;
    }
    case "update_reservation_status":
      return `✅ Reserva actualizada a "${args.status}".`;
    case "accept_rate_recommendation": {
      const rec = (r.data ?? r) as Record<string, any>;
      const date = rec.date ? ` del ${rec.date}` : "";
      const rate =
        typeof rec.suggestedRateUsd === "number"
          ? ` — nueva tarifa USD ${rec.suggestedRateUsd}`
          : "";
      return `✅ Recomendación${date} aceptada${rate}. Se aplica al motor de reservas.`;
    }
    case "reject_rate_recommendation": {
      const rec = (r.data ?? r) as Record<string, any>;
      const date = rec.date ? ` del ${rec.date}` : "";
      return `✅ Recomendación${date} rechazada. La tarifa queda como está.`;
    }
    default:
      return "✅ Acción ejecutada.";
  }
}

// Mensaje accionable segun el tipo de error de la tool (lo ve el usuario).
function actionErrorMessage(err: ToolExecutionError): string {
  switch (err.kind) {
    case "forbidden":
      return "No tenés permisos para esta acción en esta propiedad.";
    case "policy":
      // La política del agente ya arma el mensaje con el permiso que falta.
      return err.message;
    case "unauthorized":
      return "No se pudo autenticar la acción contra el sistema. Reportalo al equipo roombir.";
    case "validation":
      return `No se pudo completar: ${err.message}`;
    case "not_found":
      return "No se encontró el recurso de la acción.";
    case "upstream":
    case "network":
      return "El servicio no respondió. Probá de nuevo en unos minutos.";
    default:
      return `No se pudo completar la acción: ${err.message}`;
  }
}

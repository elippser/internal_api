/**
 * Superficie de sistema del motor (§9.2, familia "Sistema").
 *
 * Cumple dos funciones distintas:
 *
 *  1. SALUD Y CAPACIDAD — inventario de trabajadores, profundidad de cola,
 *     ranuras. Es lo que se mira cuando "el agente no responde": la respuesta
 *     casi siempre es que no hay ranuras libres o que no hay ningún worker
 *     latiendo, y sin este endpoint eso se descubre leyendo logs.
 *
 *  2. VOCABULARIO DE AUTORÍA — qué tipos de grafo, capacidades, tipos de
 *     herramienta, modelos y niveles de esfuerzo existen HOY en este
 *     despliegue. La consola lo consume para construir sus selectores en vez de
 *     hardcodear listas que se desincronizan del backend en la primera semana.
 */
import type { Request, Response } from "express";
import { ok } from "../../shared/utils/http";
import { getEngineConfig } from "../../engine/core/config";
import { protocolContract } from "../../engine/events/protocol";
import { listCatalog } from "../../engine/llm/catalog";
import { listProviders } from "../../engine/llm/client";
import {
  forceRefreshOpenRouterCatalog,
  isOpenRouterWarm,
  openRouterKeyStatus,
} from "../../engine/llm/providers/openrouterCatalog";
import { transactionSupport } from "../../engine/runtime/persistence";
import { capabilityMap, listCodeTools, pendingCapabilities } from "../../engine/tools/registry";
import { workerHealth } from "../../engine/worker";
import {
  AUTHORABLE_GRAPH_TYPES,
  CONCURRENCY_MODES,
  EXECUTION_LANES,
  EXECUTION_STATUSES,
  GRAPH_TYPES,
  HUMAN_RESUMABLE_STATUSES,
  IN_FLIGHT_STATUSES,
  RUNTIME_CAPABILITIES,
  STOP_WAITING_STATUSES,
  SUB_AGENT_MODES,
  TERMINAL_STATUSES,
  TOOL_TYPES,
  WAITING_STATUSES,
} from "../../engine/models/enums";

export const engineSystemController = {
  async health(_req: Request, res: Response) {
    const cfg = getEngineConfig();
    const health = await workerHealth();
    return ok(res, {
      ok: true,
      environment: cfg.environment,
      ...health,
      persistence: {
        // `null` = todavía no se probó una transacción en este proceso.
        multiDocumentTransactions: transactionSupport(),
        payloadsEnabled: cfg.payloadsEnabled,
        eventJournalEnabled: cfg.eventJournalEnabled,
      },
    });
  },

  /**
   * Catálogo de modelos con sus capacidades reales: los de primera parte más
   * los del gateway agregador. `value` es el nombre CUALIFICADO tal como se
   * guarda en la versión del agente — la consola no tiene que armarlo.
   */
  async models(_req: Request, res: Response) {
    return ok(res, {
      providers: listProviders(),
      gatewayWarm: isOpenRouterWarm(),
      gatewayKey: openRouterKeyStatus(),
      models: listCatalog().map((m) => ({
        id: m.id,
        value: `${m.provider}/${m.id}`,
        label: m.label,
        provider: m.provider,
        vendor: m.provider === "openrouter" && m.id.includes("/")
          ? m.id.slice(0, m.id.indexOf("/"))
          : m.provider,
        contextWindowTokens: m.contextWindowTokens,
        maxOutputTokens: m.maxOutputTokens,
        vision: m.vision,
        thinkingModes: m.thinkingModes,
        thinksByDefault: m.thinksByDefault,
        supportsDisabledThinking: m.supportsDisabledThinking,
        effortLevels: m.effortLevels,
        supportsSampling: m.supportsSampling,
        cacheMinimumTokens: m.cacheMinimumTokens,
      })),
    });
  },

  /**
   * Fuerza la recarga del catálogo del gateway.
   *
   * Existe porque la clave se configura en el `.env` y el proceso de la API no
   * vigila ese archivo: quien la acaba de poner necesita una forma de aplicarla
   * sin reiniciar el servidor a ciegas.
   */
  async refreshModels(_req: Request, res: Response) {
    const result = await forceRefreshOpenRouterCatalog();
    return ok(res, {
      ...result,
      // El motivo sale del estado REAL de la clave, no de una conjetura: la
      // diferencia entre "clave de gestión" y "clave revocada" cambia qué tiene
      // que hacer el operador, y adivinar lo manda al lugar equivocado.
      hint: result.reason,
    });
  },

  /**
   * Vocabulario de autoría. Publica también los conjuntos DERIVADOS de estado
   * para que la consola no los recalcule: recalcularlos del lado del cliente es
   * exactamente cómo "terminó" y "dejá de esperar" se vuelven a confundir.
   */
  async vocabulary(_req: Request, res: Response) {
    return ok(res, {
      graphTypes: { all: GRAPH_TYPES, authorable: AUTHORABLE_GRAPH_TYPES },
      capabilities: {
        all: RUNTIME_CAPABILITIES,
        // Declaradas pero sin herramientas en esta entrega. La consola las
        // muestra como "próximamente" en vez de ofrecer un interruptor que
        // deja al agente sin las herramientas que promete.
        pending: pendingCapabilities(),
      },
      capabilityTools: capabilityMap(),
      toolTypes: {
        all: TOOL_TYPES,
        // Estos dos no pueden nacer de una fila del catálogo.
        notFromCatalog: ["function", "sub_agent"],
      },
      concurrencyModes: CONCURRENCY_MODES,
      subAgentModes: SUB_AGENT_MODES,
      lanes: EXECUTION_LANES,
      executionStatuses: {
        all: EXECUTION_STATUSES,
        waiting: WAITING_STATUSES,
        terminal: TERMINAL_STATUSES,
        stopWaiting: STOP_WAITING_STATUSES,
        inFlight: IN_FLIGHT_STATUSES,
        humanResumable: HUMAN_RESUMABLE_STATUSES,
      },
      interruptionTriggers: {
        supported: ["tool_call", "turn_count"],
        rejected: {
          cost_threshold:
            "Rechazado a propósito: no tiene implementación en runtime. Aceptarlo prometería " +
            "una compuerta de aprobación que nunca frena nada.",
        },
      },
    });
  },

  /** Contrato de eventos, para generación de SDK y verificación de deriva. */
  async eventProtocol(_req: Request, res: Response) {
    return ok(res, protocolContract());
  },

  /** Herramientas de código registradas en ESTE proceso. */
  async registry(_req: Request, res: Response) {
    return ok(
      res,
      listCodeTools().map((t) => ({
        name: t.name,
        description: t.description,
        type: t.type,
        origin: t.origin,
        concurrency: t.concurrency,
        roleFloor: t.roleFloor ?? null,
      })),
    );
  },
};

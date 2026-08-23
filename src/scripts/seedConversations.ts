/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { connectDB } from "../shared/db";
import { AgentDefinition, slugify } from "../modules/agents/agents.model";
import { KnowledgeBase, KnowledgeDocument } from "../modules/knowledge/knowledge.model";
import { Tool, INITIAL_TOOLS } from "../modules/tools/tools.model";
import {
  ConversationMessage,
  ConversationSession,
} from "../modules/conversations/conversations.model";
import { processDocument } from "../shared/rag/documentProcessor";
import { makeId } from "../shared/utils/ids";

const KB_NAME = "Operaciones PMS - basico";
const AGENT_SLUG = "asistente-operaciones";

const DOC_OPERACIONES = `# Manual de Operaciones - PMS

## Estados de habitacion
Las habitaciones pueden estar en uno de los siguientes estados:
- **Disponible**: lista para asignar a una reserva
- **Ocupada**: hay un huesped checked-in actualmente
- **Sucia**: necesita limpieza, no se puede asignar
- **Bloqueada**: fuera de servicio por mantenimiento

Para cambiar el estado usa la herramienta change_room_status. Solo el personal
con rol owner o admin puede bloquear habitaciones.

## Reservas: ciclo de vida
1. **Pending**: reserva creada, falta confirmar pago
2. **Confirmed**: pago recibido, asignada a habitacion
3. **Checked-in**: huesped en el hotel
4. **Checked-out**: reserva finalizada
5. **Cancelled**: cancelada por el huesped o el hotel

## Politicas de cancelacion
La politica por defecto es:
- Mas de 48hs antes del check-in: reembolso 100%
- Entre 24 y 48hs: reembolso 50%
- Menos de 24hs: sin reembolso

Cada propiedad puede sobreescribir esta politica en su configuracion.

## Reportes diarios
El reporte de operaciones se genera todos los dias a las 8am y contiene:
- Llegadas esperadas
- Salidas esperadas
- Habitaciones disponibles para venta walk-in
- Reservas pendientes de cobro
`;

const DOC_INTEGRACIONES = `# Integraciones disponibles

## Canales de venta conectados
El PMS se conecta nativamente con los siguientes canales:
- Motor de reservas propio (engine)
- Expedia
- Despegar

Booking.com y Airbnb estan en roadmap pero NO estan disponibles todavia.

## Pasarelas de pago
Pagos soportados:
- Mercado Pago (Argentina)
- Stripe (resto del mundo)

## API y webhooks
Tenemos API REST para consultar disponibilidad y crear reservas.
Los webhooks se pueden configurar en Settings > Integraciones.
`;

async function ensureTools() {
  const count = await Tool.countDocuments();
  if (count > 0) return;
  console.log("Sembrando tools iniciales...");
  await Tool.insertMany(
    INITIAL_TOOLS.map((t) => ({
      ...t,
      permissions: {
        requiredRoles: ["owner", "admin", "staff"],
        requiresConfirmation: t.permissions.requiresConfirmation,
        isDestructive: t.permissions.isDestructive,
      },
      execution: {
        ...t.execution,
        authStrategy: "staff_jwt",
        timeout: 10000,
      },
    })),
  );
}

async function ensureKb() {
  let kb = await KnowledgeBase.findOne({ name: KB_NAME });
  if (kb) return kb;
  kb = await KnowledgeBase.create({
    knowledgeBaseId: makeId("kb"),
    name: KB_NAME,
    description: "Base demo con politicas y operaciones basicas del PMS",
    language: "es",
    status: "ready",
  });
  console.log("KB creada:", kb.knowledgeBaseId);
  return kb;
}

async function ensureDocument(
  kbId: string,
  title: string,
  markdown: string,
) {
  const existing = await KnowledgeDocument.findOne({
    knowledgeBaseId: kbId,
    "metadata.title": title,
  });
  if (existing && existing.status === "indexed" && existing.chunkCount > 0) {
    return existing;
  }
  const doc = existing
    ? existing
    : await KnowledgeDocument.create({
        documentId: makeId("doc"),
        knowledgeBaseId: kbId,
        sourceType: "markdown",
        originalName: `${title}.md`,
        rawText: markdown,
        metadata: { title, tags: ["seed"] },
        status: "processing",
      });

  console.log(`Indexando documento "${title}" (${doc.documentId})...`);
  await processDocument({
    documentId: doc.documentId,
    knowledgeBaseId: kbId,
    sourceType: "markdown",
    rawText: markdown,
    title,
  });
  return doc;
}

async function ensureAgent(kbId: string) {
  let agent = await AgentDefinition.findOne({ slug: AGENT_SLUG });
  if (agent) {
    // Asegurar que apunte a la KB recien creada
    if (!agent.knowledgeBaseIds.includes(kbId)) {
      agent.knowledgeBaseIds.push(kbId);
      await agent.save();
    }
    return agent;
  }

  const tools = await Tool.find({
    name: {
      $in: [
        "check_availability",
        "get_reservations",
        "get_reservation_detail",
        "get_room_states",
        "create_reservation",
      ],
    },
  });

  agent = await AgentDefinition.create({
    agentId: makeId("agent"),
    name: "Asistente de Operaciones",
    slug: slugify("Asistente de Operaciones"),
    description: "Agente demo para Q&A operativo + acciones basicas en el PMS",
    status: "active",
    persona: {
      displayName: "Asistente de Operaciones",
      tone: "friendly",
      language: "es",
      personality: "Conciso, directo y siempre confirma acciones de escritura.",
    },
    instructions: {
      systemPrompt:
        "Sos el asistente operativo del PMS para el hotel {propertyName}. " +
        "Atendes a {userName} ({userRole}). Hoy es {currentDate}. " +
        "Respondes con precision y brevedad. Si una funcionalidad no existe " +
        "todavia y el usuario la pide, ofrece registrarla como pedido.",
      constraints: [
        "Nunca inventes datos de reservas o disponibilidad - usa las herramientas",
        "Antes de crear o modificar algo, describi la accion y pedi confirmacion",
        "Si el usuario pide algo que la plataforma no soporta, registralo via capture_feedback_request",
      ],
      examples: [],
    },
    knowledgeBaseIds: [kbId],
    enabledToolIds: tools.map((t) => t.toolId),
    deployment: {
      channel: "pms_app",
      allowedCompanyIds: [],
      requiresAuth: true,
    },
    feedbackCapture: {
      enabled: true,
      autoClassify: true,
      confirmWithUser: true,
    },
    limits: {
      maxTurnsPerSession: 50,
      maxTokensPerTurn: 4096,
      sessionTtlMinutes: 60,
    },
    createdByUserId: "seed",
  });
  console.log("Agente creado:", agent.agentId);
  return agent;
}

async function buildSyntheticSession(
  agent: any,
  scenario: "rag_only" | "with_tool" | "with_feedback",
  daysAgo: number,
) {
  const sessionId = `sess-${uuidv4()}`;
  const startedAt = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  const lastActivity = new Date(startedAt.getTime() + 5 * 60 * 1000);

  const session = await ConversationSession.create({
    sessionId,
    agentId: agent.agentId,
    context: {
      userId: `user-demo-${daysAgo}`,
      companyId: "company-demo",
      propertyId: "property-demo",
      userRole: "admin",
      channel: "pms_app",
      userName: "Demo User",
      propertyName: "Hotel Demo",
      companyName: "Demo Company",
    },
    status: "ended",
    turnCount: 0,
    feedbackRequestIds: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    startedAt,
    lastActivityAt: lastActivity,
    endedAt: lastActivity,
  });

  if (scenario === "rag_only") {
    await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId,
      agentId: agent.agentId,
      role: "user",
      content: "Cual es la politica de cancelacion por defecto?",
      createdAt: startedAt,
    });
    await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId,
      agentId: agent.agentId,
      role: "assistant",
      content:
        "Por defecto, mas de 48hs antes del check-in se reembolsa el 100%, " +
        "entre 24 y 48hs el 50%, y con menos de 24hs no hay reembolso. " +
        "Cada propiedad puede sobreescribir esta politica desde su configuracion.",
      agentMeta: {
        ragChunksUsed: [],
        toolsExecuted: [],
        inputTokens: 1240,
        outputTokens: 88,
        latencyMs: 1850,
        modelUsed: "claude-sonnet-4-6",
        stopReason: "end_turn",
      },
      createdAt: new Date(startedAt.getTime() + 30 * 1000),
    });
    session.turnCount = 1;
    session.totalInputTokens = 1240;
    session.totalOutputTokens = 88;
    await session.save();
    return;
  }

  if (scenario === "with_tool") {
    await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId,
      agentId: agent.agentId,
      role: "user",
      content: "Cuantas habitaciones disponibles tengo para esta noche?",
      createdAt: startedAt,
    });
    await ConversationMessage.create({
      messageId: `msg-${uuidv4()}`,
      sessionId,
      agentId: agent.agentId,
      role: "assistant",
      content:
        "Para hoy tenes 8 habitaciones disponibles: 3 dobles, 4 singles y " +
        "1 suite. Las dobles tienen tarifa promo activa de 15% off.",
      agentMeta: {
        ragChunksUsed: [],
        toolsExecuted: [
          {
            toolId: "tool-001",
            toolName: "check_availability",
            inputArgs: { date: "today" },
            outcome: "success",
            result: {
              availableUnits: 8,
              breakdown: { double: 3, single: 4, suite: 1 },
            },
            durationMs: 312,
            retried: false,
          },
        ],
        inputTokens: 1480,
        outputTokens: 142,
        latencyMs: 2640,
        modelUsed: "claude-sonnet-4-6",
        stopReason: "end_turn",
      },
      createdAt: new Date(startedAt.getTime() + 45 * 1000),
    });
    session.turnCount = 1;
    session.totalInputTokens = 1480;
    session.totalOutputTokens = 142;
    await session.save();
    return;
  }

  // with_feedback
  await ConversationMessage.create({
    messageId: `msg-${uuidv4()}`,
    sessionId,
    agentId: agent.agentId,
    role: "user",
    content: "Puedo conectar el PMS con Booking.com?",
    createdAt: startedAt,
  });
  await ConversationMessage.create({
    messageId: `msg-${uuidv4()}`,
    sessionId,
    agentId: agent.agentId,
    role: "assistant",
    content:
      "La integracion con Booking.com no esta disponible todavia, esta en " +
      "roadmap. Queres que registre el pedido para que el equipo lo evalue?",
    agentMeta: {
      ragChunksUsed: [],
      toolsExecuted: [],
      inputTokens: 1320,
      outputTokens: 64,
      latencyMs: 1640,
      modelUsed: "claude-sonnet-4-6",
      stopReason: "end_turn",
    },
    createdAt: new Date(startedAt.getTime() + 35 * 1000),
  });
  await ConversationMessage.create({
    messageId: `msg-${uuidv4()}`,
    sessionId,
    agentId: agent.agentId,
    role: "user",
    content: "Si dale, registralo",
    createdAt: new Date(startedAt.getTime() + 60 * 1000),
  });
  await ConversationMessage.create({
    messageId: `msg-${uuidv4()}`,
    sessionId,
    agentId: agent.agentId,
    role: "assistant",
    content:
      "Listo, lo registre como pedido. El equipo lo va a evaluar.",
    agentMeta: {
      ragChunksUsed: [],
      toolsExecuted: [
        {
          toolId: "internal-feedback",
          toolName: "capture_feedback_request",
          inputArgs: {
            rawUserMessage: "Puedo conectar el PMS con Booking.com?",
            intent: "ota_integration_booking_com",
            category: "integration",
            confidence: "high",
            summary: "Pedido de integracion con Booking.com",
            userConfirmed: true,
          },
          outcome: "success",
          result: { feedbackId: "fb-demo" },
          durationMs: 28,
          retried: false,
        },
      ],
      inputTokens: 1420,
      outputTokens: 40,
      latencyMs: 1380,
      modelUsed: "claude-sonnet-4-6",
      stopReason: "end_turn",
    },
    createdAt: new Date(startedAt.getTime() + 85 * 1000),
  });
  session.turnCount = 2;
  session.totalInputTokens = 2740;
  session.totalOutputTokens = 104;
  session.feedbackRequestIds = ["fb-demo"];
  await session.save();
}

async function seedConversations(agent: any) {
  const existing = await ConversationSession.countDocuments({
    agentId: agent.agentId,
  });
  if (existing > 0) {
    console.log(`Ya hay ${existing} sesiones para el agente, skip`);
    return;
  }
  console.log("Sembrando sesiones sinteticas...");
  await buildSyntheticSession(agent, "rag_only", 0);
  await buildSyntheticSession(agent, "with_tool", 1);
  await buildSyntheticSession(agent, "with_feedback", 2);
  await buildSyntheticSession(agent, "rag_only", 4);
}

async function main() {
  await connectDB();
  await ensureTools();
  const kb = await ensureKb();
  await ensureDocument(kb.knowledgeBaseId, "Operaciones", DOC_OPERACIONES);
  await ensureDocument(kb.knowledgeBaseId, "Integraciones", DOC_INTEGRACIONES);
  const agent = await ensureAgent(kb.knowledgeBaseId);
  await seedConversations(agent);

  // Pequeno delay para que el processor background termine si todavia
  // hay algo en flight. processDocument es await, asi que en realidad
  // ya termino, pero por las dudas.
  await new Promise((r) => setTimeout(r, 500));

  console.log("Seed conversations OK");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed conversations failed:", err);
  process.exit(1);
});

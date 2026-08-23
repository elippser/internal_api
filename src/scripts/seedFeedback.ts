import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { AgentDefinition } from "../modules/agents/agents.model";
import { FeedbackRequest } from "../modules/feedback/feedback.model";
import { makeId } from "../shared/utils/ids";

const SAMPLES = [
  {
    rawUserMessage:
      "El motor no me deja integrar Mercado Pago en propiedades de Brasil",
    response:
      "Es una limitacion conocida; vamos a derivar tu reporte al equipo.",
    category: "integration",
    confidence: "high",
    summary: "Integracion MP Brasil no soportada",
    confirmed: true,
  },
  {
    rawUserMessage: "Necesito poder cobrar en cuotas con Decidir",
    response: "Vamos a registrar tu solicitud para el roadmap.",
    category: "payment",
    confidence: "high",
    summary: "Cuotas con Decidir",
    confirmed: true,
  },
  {
    rawUserMessage:
      "Los reportes de ocupacion no exportan a Excel correctamente",
    response: "Voy a registrar el bug.",
    category: "bug",
    confidence: "high",
    summary: "Export Excel reportes ocupacion roto",
    confirmed: true,
  },
  {
    rawUserMessage: "Quiero un dashboard de revenue por canal",
    response: "Lo registro como feature request.",
    category: "reporting",
    confidence: "medium",
    summary: "Dashboard revenue por canal",
    confirmed: true,
  },
  {
    rawUserMessage: "Los precios en el builder no se ven bien en mobile",
    response: "Voy a derivar el reporte de UI.",
    category: "ui_ux",
    confidence: "high",
    summary: "Precios mobile mal renderizados",
    confirmed: true,
  },
  {
    rawUserMessage: "Falta integrar con Despegar",
    response: "Anotado como integracion pendiente.",
    category: "integration",
    confidence: "high",
    summary: "Integracion Despegar",
    confirmed: true,
  },
  {
    rawUserMessage:
      "El comprobante de pago no incluye CUIT del huesped si es empresa",
    response: "Lo registro como bug fiscal.",
    category: "bug",
    confidence: "medium",
    summary: "Comprobante sin CUIT empresa",
    confirmed: true,
  },
  {
    rawUserMessage:
      "Me gustaria poder pre-asignar habitaciones desde el motor publico",
    response: "Lo anoto como feature.",
    category: "feature",
    confidence: "medium",
    summary: "Pre-asignacion habitaciones",
    confirmed: false,
  },
  {
    rawUserMessage:
      "El bot a veces tarda demasiado en responder cuando llamo con muchas reservas",
    response: "Voy a reportar el problema de performance.",
    category: "bug",
    confidence: "medium",
    summary: "Latencia alta con muchas reservas",
    confirmed: false,
  },
  {
    rawUserMessage: "Como cambio la moneda default?",
    response: "Te paso un enlace al setting.",
    category: "other",
    confidence: "low",
    summary: "Duda sobre moneda default",
    confirmed: false,
  },
  {
    rawUserMessage:
      "Mercado Pago me esta cobrando dos veces a algunos huespedes",
    response: "Esto es critico, lo elevo de inmediato.",
    category: "payment",
    confidence: "high",
    summary: "Doble cobro MP",
    confirmed: true,
  },
  {
    rawUserMessage: "Necesito traduccion de los emails al portugues",
    response: "Lo anoto como feature i18n.",
    category: "feature",
    confidence: "medium",
    summary: "Emails en portugues",
    confirmed: true,
  },
];

const COMPANIES = ["co-001", "co-002", "co-003", "co-004", "co-005"];
const PROPERTIES = ["prop-aa", "prop-bb", "prop-cc"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function dateInLastDays(days: number): Date {
  return new Date(Date.now() - Math.random() * days * 24 * 60 * 60 * 1000);
}

async function seed() {
  await connectDB();

  const existing = await FeedbackRequest.countDocuments();
  if (existing > 0) {
    console.log(
      `• Ya hay ${existing} feedbacks; skip (borralos manual si queres regenerar)`,
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  const agents = await AgentDefinition.find().limit(5);
  if (agents.length === 0) {
    console.log(
      "• No hay agentes. Crea al menos uno desde la UI antes de seedear feedback.",
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  // Distribuimos: ~60% new, ~25% reviewed, ~10% linked_to_ticket, ~5% discarded
  const docs: any[] = [];
  let i = 0;
  for (const sample of SAMPLES) {
    for (let copy = 0; copy < 2; copy++) {
      const agent = pick(agents);
      const rand = Math.random();
      const status =
        rand < 0.6
          ? "new"
          : rand < 0.85
            ? "reviewed"
            : rand < 0.95
              ? "linked_to_ticket"
              : "discarded";
      const capturedAt = dateInLastDays(30);

      docs.push({
        feedbackId: makeId("fb"),
        agentId: agent.agentId,
        sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
        companyId: pick(COMPANIES),
        propertyId: Math.random() > 0.3 ? pick(PROPERTIES) : null,
        rawUserMessage: sample.rawUserMessage,
        agentResponse: sample.response,
        classification: {
          intent: sample.summary,
          category: sample.category,
          confidence: sample.confidence,
          summary: sample.summary,
        },
        userConfirmed: sample.confirmed,
        status,
        linkedTicketId: status === "linked_to_ticket" ? `ticket-mock-${i}` : null,
        capturedAt,
        reviewedAt:
          status === "reviewed" || status === "discarded"
            ? new Date(capturedAt.getTime() + 3 * 60 * 60 * 1000)
            : undefined,
      });
      i++;
    }
  }

  await FeedbackRequest.insertMany(docs);
  console.log(`✓ ${docs.length} feedbacks insertados`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seedFeedback] error:", err);
  process.exit(1);
});

import { Schema, model, type InferSchemaType } from "mongoose";

// Memoria de largo plazo del agente, compartida por operativeSpace (todos los
// usuarios del mismo espacio comparten una "memoria de equipo"). Se destila de
// las conversaciones y se inyecta en el system prompt de futuras charlas.
// Es clearable (el usuario puede borrarla).
export const MEMORY_KINDS = ["preference", "fact", "context"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const memorySchema = new Schema(
  {
    memoryId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, default: null, index: true },

    // Scope: operativeSpace es la clave de agrupacion; company/property se
    // guardan para filtros/auditoria.
    companyId: { type: String, default: null, index: true },
    propertyId: { type: String, default: null },
    operativeSpaceId: { type: String, default: null, index: true },

    content: { type: String, required: true },
    kind: { type: String, enum: MEMORY_KINDS, default: "context" },

    sourceSessionId: { type: String, default: null },
    createdByUserId: { type: String, default: null },
  },
  { timestamps: true, collection: "agent_memories" },
);

memorySchema.index({ operativeSpaceId: 1, updatedAt: -1 });

export type MemoryDoc = InferSchemaType<typeof memorySchema>;
export const AgentMemory = model("AgentMemory", memorySchema);

export function sanitizeMemory(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}

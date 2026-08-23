import { makeId } from "../../shared/utils/ids";
import { MktAccount, MktContact, sanitizeDoc } from "./crm.model";
import {
  MktSegment,
  SYSTEM_SEGMENTS,
  buildSegmentQuery,
} from "./segments.model";

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

export const segmentsService = {
  /** Crea los segmentos del sistema si faltan. Idempotente por nombre. */
  async ensureSystemSegments() {
    let created = 0;
    for (const seed of SYSTEM_SEGMENTS) {
      const exists = await MktSegment.findOne({ name: seed.name, isSystem: true });
      if (exists) continue;
      await MktSegment.create({
        ...seed,
        segmentId: makeId("seg"),
        isSystem: true,
        createdByUserId: "system",
      });
      created++;
    }
    return { created };
  },

  async list() {
    const rows = await MktSegment.find().sort({ isSystem: -1, name: 1 }).lean();

    // El conteo se resuelve en vivo: es lo unico que hace util la lista.
    const withCounts = await Promise.all(
      rows.map(async (s) => ({
        ...sanitizeDoc(s),
        count: await MktAccount.countDocuments(
          buildSegmentQuery(s.rules as never, s.match as "all" | "any"),
        ),
      })),
    );
    return withCounts;
  },

  async getOne(segmentId: string) {
    const seg = await MktSegment.findOne({ segmentId }).lean();
    if (!seg) throw httpError(404, "Segmento no encontrado", "not_found");
    const query = buildSegmentQuery(seg.rules as never, seg.match as "all" | "any");
    return {
      ...sanitizeDoc(seg),
      count: await MktAccount.countDocuments(query),
    };
  },

  async create(input: Record<string, any>, userId: string) {
    const doc = await MktSegment.create({
      ...input,
      segmentId: makeId("seg"),
      isSystem: false,
      createdByUserId: userId,
    });
    return sanitizeDoc(doc.toObject());
  },

  async update(segmentId: string, patch: Record<string, any>) {
    const doc = await MktSegment.findOneAndUpdate(
      { segmentId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Segmento no encontrado", "not_found");
    return sanitizeDoc(doc);
  },

  async remove(segmentId: string) {
    const seg = await MktSegment.findOne({ segmentId });
    if (!seg) throw httpError(404, "Segmento no encontrado", "not_found");
    if (seg.isSystem) {
      throw httpError(400, "Los segmentos del sistema no se borran", "is_system");
    }
    await MktSegment.deleteOne({ segmentId });
    return { deleted: true };
  },

  /** Resuelve el segmento a cuentas. Lo consumen la UI y las campañas. */
  async resolveAccounts(segmentId: string, limit = 500) {
    const seg = await MktSegment.findOne({ segmentId }).lean();
    if (!seg) throw httpError(404, "Segmento no encontrado", "not_found");

    const query = buildSegmentQuery(seg.rules as never, seg.match as "all" | "any");
    const [accounts, total] = await Promise.all([
      MktAccount.find(query).sort({ updatedAt: -1 }).limit(limit).lean(),
      MktAccount.countDocuments(query),
    ]);
    return { data: accounts.map(sanitizeDoc), total };
  },

  /**
   * Contactos destinatarios de un segmento, listos para una campaña.
   *
   * Filtra por `optIn` del canal y descarta a quien se dio de baja: el chequeo
   * vive acá y no en el envio para que no se pueda saltear por accidente desde
   * otro punto de entrada.
   */
  async resolveRecipients(segmentId: string, channel: "email" | "whatsapp") {
    const { data: accounts } = await this.resolveAccounts(segmentId, 5000);
    const accountIds = (accounts as any[]).map((a) => a.accountId);
    if (accountIds.length === 0) return [];

    const contacts = await MktContact.find({
      accountId: { $in: accountIds },
      unsubscribedAt: { $exists: false },
      [`optIn.${channel}`]: true,
      ...(channel === "whatsapp" ? { phone: { $exists: true, $ne: "" } } : {}),
    }).lean();

    return contacts.map(sanitizeDoc);
  },
};

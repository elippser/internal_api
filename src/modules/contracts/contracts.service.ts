import { makeId } from "../../shared/utils/ids";
import { usageService } from "../usage/usage.service";
import {
  Contract,
  defaultApps,
  sanitizeContract,
  type ContractStatus,
} from "./contracts.model";

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

// Flag global de enforcement. "off" desactiva el bloqueo (util durante la
// migracion para no cortarle la IA a las companies sin contrato todavia).
export function iaEnforcementOn(): boolean {
  return process.env.IA_CREDITS_ENFORCEMENT !== "off";
}

export type CreditsReason =
  | "ok"
  | "no_contract"
  | "ia_disabled"
  | "no_credits"
  | "enforcement_off";

export interface CompanyCredits {
  companyId: string;
  hasContract: boolean;
  iaEnabled: boolean;
  blocked: boolean;
  reason: CreditsReason;
  monthlyCredits: number;
  consumed: number;
  remaining: number; // puede ser negativo si hubo overshoot en el ultimo turno
  periodStart: Date | null;
  periodEnd: Date | null;
  contractId: string | null;
}

// Ventana del periodo mensual vigente, anclada al dia de reset (UTC).
function currentPeriod(resetDayUTC: number): { start: Date; end: Date } {
  const now = new Date();
  const day = Math.min(28, Math.max(1, resetDayUTC || 1));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  // Si ya pasamos el dia de corte este mes, el periodo arranco este mes;
  // si no, arranco el mes anterior. Date.UTC normaliza el overflow de meses.
  const start =
    d >= day ? new Date(Date.UTC(y, m, day)) : new Date(Date.UTC(y, m - 1, day));
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day),
  );
  return { start, end };
}

// Mensaje accionable segun el motivo de bloqueo (lo ve el hotelero en el chat).
export function creditsMessage(c: CompanyCredits): string {
  switch (c.reason) {
    case "no_contract":
      return "Esta cuenta no tiene un contrato de IA activo. Contacta al equipo bookfer para habilitarlo.";
    case "ia_disabled":
      return "El contrato de esta cuenta no tiene la IA habilitada.";
    case "no_credits": {
      const reset = c.periodEnd
        ? new Date(c.periodEnd).toLocaleDateString("es-AR", { timeZone: "UTC" })
        : "el proximo periodo";
      return `Se agotaron los creditos de IA del periodo (${c.consumed.toLocaleString()}/${c.monthlyCredits.toLocaleString()} tokens). Se renuevan el ${reset}.`;
    }
    default:
      return "Sin creditos de IA disponibles.";
  }
}

export const contractsService = {
  // ---------------- CRUD ----------------
  async list(opts: {
    status?: string;
    companyId?: string;
    search?: string;
    page: number;
    limit: number;
    skip: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (opts.status) filter.status = opts.status;
    if (opts.companyId) filter.companyId = opts.companyId;
    if (opts.search) {
      filter.$or = [
        { name: { $regex: opts.search, $options: "i" } },
        { companyId: { $regex: opts.search, $options: "i" } },
      ];
    }
    const [docs, total] = await Promise.all([
      Contract.find(filter)
        .sort({ updatedAt: -1 })
        .skip(opts.skip)
        .limit(opts.limit),
      Contract.countDocuments(filter),
    ]);
    return {
      data: docs.map(sanitizeContract),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  },

  async getOne(contractId: string) {
    const doc = await Contract.findOne({ contractId });
    return doc ? sanitizeContract(doc) : null;
  },

  async create(input: Record<string, unknown>, createdByUserId: string) {
    const doc = await Contract.create({
      contractId: makeId("contract"),
      name: input.name,
      description: input.description ?? "",
      companyIds: [],
      appliesToAll: input.appliesToAll === true,
      status: "draft",
      ia: input.ia ?? {},
      apps: Array.isArray(input.apps) && input.apps.length
        ? input.apps
        : defaultApps(),
      createdByUserId,
    });
    return sanitizeContract(doc);
  },

  async update(contractId: string, input: Record<string, unknown>) {
    const doc = await Contract.findOneAndUpdate(
      { contractId },
      { $set: input, $inc: { version: 1 } },
      { new: true },
    );
    if (!doc) throw httpError(404, "Contrato no encontrado", "not_found");
    return sanitizeContract(doc);
  },

  // Reemplaza el set de companies del contrato. Si esta activo, valida que
  // ninguna este en otro contrato activo.
  async associate(contractId: string, companyIds: string[]) {
    const contract = await Contract.findOne({ contractId });
    if (!contract) throw httpError(404, "Contrato no encontrado", "not_found");

    const unique = [...new Set(companyIds.filter(Boolean))];
    if (contract.status === "active") {
      await this.assertNoOtherActive(unique, contractId);
    }
    contract.companyIds = unique;
    await contract.save();
    return sanitizeContract(contract);
  },

  async updateStatus(contractId: string, status: ContractStatus) {
    const contract = await Contract.findOne({ contractId });
    if (!contract) throw httpError(404, "Contrato no encontrado", "not_found");

    if (status === "active") {
      if (contract.appliesToAll) {
        // Solo un contrato global activo a la vez.
        const otherGlobal = await Contract.findOne({
          appliesToAll: true,
          status: "active",
          contractId: { $ne: contractId },
        });
        if (otherGlobal) {
          throw httpError(
            409,
            `Ya hay un contrato global activo (${otherGlobal.contractId})`,
            "global_contract_exists",
          );
        }
      } else {
        if (!contract.companyIds || contract.companyIds.length === 0) {
          throw httpError(
            409,
            "Asocia al menos una company (o marcá 'aplica a todas') antes de activar el contrato",
            "company_required",
          );
        }
        await this.assertNoOtherActive(
          contract.companyIds as string[],
          contractId,
        );
      }
    }
    contract.status = status;
    await contract.save();
    return sanitizeContract(contract);
  },

  async assertNoOtherActive(companyIds: string[], exceptContractId: string) {
    if (companyIds.length === 0) return;
    const other = await Contract.findOne({
      status: "active",
      contractId: { $ne: exceptContractId },
      companyIds: { $in: companyIds },
    });
    if (other) {
      const clash = (other.companyIds as string[]).filter((c) =>
        companyIds.includes(c),
      );
      throw httpError(
        409,
        `Ya hay un contrato activo (${other.contractId}) para: ${clash.join(", ")}`,
        "company_has_active_contract",
      );
    }
  },

  // ---------------- Creditos de IA ----------------
  /**
   * Balance de creditos de IA de una company para el periodo vigente.
   * No aplica el flag de enforcement: solo calcula. El bloqueo lo decide el
   * caller con `blocked` (que SI respeta el flag via checkCredits).
   */
  async getCompanyCredits(companyId: string): Promise<CompanyCredits> {
    const base: CompanyCredits = {
      companyId,
      hasContract: false,
      iaEnabled: false,
      blocked: true,
      reason: "no_contract",
      monthlyCredits: 0,
      consumed: 0,
      remaining: 0,
      periodStart: null,
      periodEnd: null,
      contractId: null,
    };

    if (!companyId) return base;

    // Contrato específico de la company; si no hay, el contrato GLOBAL (appliesToAll).
    const contract =
      (await Contract.findOne({ companyIds: companyId, status: "active" })) ||
      (await Contract.findOne({ appliesToAll: true, status: "active" }));
    // Sin contrato igual medimos el consumo del mes calendario por company:
    // el negocio es por tokens y el operador debe poder ver su uso aunque
    // todavía no tenga plan asignado (monthlyCredits = 0 ⇒ "sin plan" en la UI).
    if (!contract) {
      const { start, end } = currentPeriod(1);
      const consumed = await usageService.consumedTokens(
        companyId,
        start,
        new Date(),
      );
      return { ...base, consumed, periodStart: start, periodEnd: end };
    }

    if (!contract.ia?.enabled) {
      return {
        ...base,
        hasContract: true,
        iaEnabled: false,
        reason: "ia_disabled",
        contractId: contract.contractId,
      };
    }

    const { start, end } = currentPeriod(contract.ia.resetDayUTC ?? 1);
    const consumed = await usageService.consumedTokens(
      companyId,
      start,
      new Date(),
    );
    const monthlyCredits = contract.ia.monthlyCredits ?? 0;
    const remaining = monthlyCredits - consumed;
    const blocked = consumed >= monthlyCredits;

    return {
      companyId,
      hasContract: true,
      iaEnabled: true,
      blocked,
      reason: blocked ? "no_credits" : "ok",
      monthlyCredits,
      consumed,
      remaining,
      periodStart: start,
      periodEnd: end,
      contractId: contract.contractId,
    };
  },

  // Balance por cada company del contrato (para el dashboard del contrato).
  async getContractCredits(contractId: string): Promise<CompanyCredits[]> {
    const contract = await Contract.findOne({ contractId });
    if (!contract) return [];
    const ids = (contract.companyIds as string[]) ?? [];
    return Promise.all(ids.map((id) => this.getCompanyCredits(id)));
  },

  /**
   * Decision de enforcement: respeta el flag global. Devuelve el balance +
   * `allowed`. Si el flag esta off, allowed=true siempre (no bloquea).
   */
  async checkCredits(
    companyId: string,
  ): Promise<CompanyCredits & { allowed: boolean; message: string }> {
    const credits = await this.getCompanyCredits(companyId);
    if (!iaEnforcementOn()) {
      return {
        ...credits,
        blocked: false,
        reason: "enforcement_off",
        allowed: true,
        message: "",
      };
    }
    return {
      ...credits,
      allowed: !credits.blocked,
      message: credits.blocked ? creditsMessage(credits) : "",
    };
  },
};

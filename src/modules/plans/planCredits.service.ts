import { getCompanyModel } from "../hotels/pmsModels";
import { usageService } from "../usage/usage.service";
import { Plan } from "./plans.model";

/**
 * Créditos de Bookfer IA resueltos DESDE EL PLAN de la company.
 *
 * Antes esto vivía en un módulo `contracts` paralelo: una company tenía un plan
 * (que decía qué productos veía) y además un contrato (que decía si tenía IA y
 * cuántos tokens). Dos fuentes de verdad para la misma pregunta, que se
 * desincronizaban solas — toda company creada después del rebrand quedó sin
 * contrato y sin IA, aunque su plan la incluyera. Contratos se eliminó y el plan
 * es ahora la única fuente.
 *
 * De dónde sale cada cosa, y por qué de ahí:
 *
 * - **Si tiene IA**: del snapshot `company.selectedPlan.productKeys`. Es lo que
 *   el PMS ya usa para decidir qué apps abre, así que el chat y el menú no
 *   pueden contradecirse. Además respeta la regla del snapshot: la cuenta
 *   conserva lo que contrató aunque después le saquen el producto al plan.
 * - **Cuántos créditos**: del plan VIVO (`plans.limits.iaMonthlyCredits`),
 *   buscado por `selectedPlan.planId`. Un cupo mensual no es algo que se
 *   "contrate para siempre": si el equipo sube el cupo del plan, aplica al mes
 *   corriente sin migrar cuenta por cuenta. Si el plan ya no existe, cae al
 *   snapshot.
 */

export const IA_PRODUCT_KEY = "bookfer-ia";

export type CreditsReason =
  | "ok"
  | "no_plan"
  | "ia_not_in_plan"
  | "no_credits"
  | "enforcement_off";

export interface CompanyCredits {
  companyId: string;
  hasPlan: boolean;
  iaEnabled: boolean;
  blocked: boolean;
  reason: CreditsReason;
  monthlyCredits: number;
  consumed: number;
  remaining: number; // puede ser negativo si hubo overshoot en el ultimo turno
  periodStart: Date | null;
  periodEnd: Date | null;
  planId: string | null;
  planName: string | null;
}

// Flag global de enforcement. "off" desactiva el bloqueo sin tocar planes.
export function iaEnforcementOn(): boolean {
  return process.env.IA_CREDITS_ENFORCEMENT !== "off";
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
    case "no_plan":
      return "Esta cuenta todavia no tiene un plan asignado. Elegi un plan para habilitar Bookfer IA.";
    case "ia_not_in_plan":
      return "El plan de esta cuenta no incluye Bookfer IA. Cambia de plan para habilitarlo.";
    case "no_credits": {
      const reset = c.periodEnd
        ? new Date(c.periodEnd).toLocaleDateString("es-AR", { timeZone: "UTC" })
        : "el proximo periodo";
      return `Se agotaron los creditos de IA del periodo (${c.consumed.toLocaleString()}/${c.monthlyCredits.toLocaleString()} tokens). Se renuevan el ${reset}.`;
    }
    default:
      return "";
  }
}

/** Snapshot del plan guardado en la company del PMS. Campos que nos importan. */
interface SelectedPlanSnapshot {
  planId?: string;
  name?: string;
  productKeys?: string[];
  limits?: { iaMonthlyCredits?: number | null; iaResetDayUTC?: number | null };
}

export const planCreditsService = {
  /**
   * Balance de creditos de IA de una company para el periodo vigente.
   * No aplica el flag de enforcement: solo calcula. El bloqueo lo decide el
   * caller con `blocked` (que SI respeta el flag via checkCredits).
   */
  async getCompanyCredits(companyId: string): Promise<CompanyCredits> {
    const base: CompanyCredits = {
      companyId,
      hasPlan: false,
      iaEnabled: false,
      blocked: true,
      reason: "no_plan",
      monthlyCredits: 0,
      consumed: 0,
      remaining: 0,
      periodStart: null,
      periodEnd: null,
      planId: null,
      planName: null,
    };

    if (!companyId) return base;

    // Lectura directa de la coleccion: el schema minimo de PmsCompany no
    // declara `selectedPlan` y .lean() se lo comeria.
    const Company = await getCompanyModel();
    const doc = (await Company.collection.findOne(
      { companyId },
      { projection: { selectedPlan: 1 } },
    )) as { selectedPlan?: SelectedPlanSnapshot } | null;

    const snapshot = doc?.selectedPlan;

    // Sin plan elegido igual medimos el consumo del mes calendario: el negocio
    // es por tokens y el operador tiene que poder ver el uso aunque la cuenta
    // todavia no haya elegido plan.
    if (!snapshot?.planId) {
      const { start, end } = currentPeriod(1);
      const consumed = await usageService.consumedTokens(
        companyId,
        start,
        new Date(),
      );
      return { ...base, consumed, periodStart: start, periodEnd: end };
    }

    const plan = await Plan.findOne({ planId: snapshot.planId }).lean();
    const planName = plan?.name ?? snapshot.name ?? null;

    // Entitlement: manda el snapshot (es lo que contrato y lo que el PMS usa
    // para el menu). Si el snapshot no trae productKeys, caemos al plan vivo.
    const productKeys = snapshot.productKeys?.length
      ? snapshot.productKeys
      : (plan?.productKeys ?? []);

    if (!productKeys.includes(IA_PRODUCT_KEY)) {
      return {
        ...base,
        hasPlan: true,
        iaEnabled: false,
        reason: "ia_not_in_plan",
        planId: snapshot.planId,
        planName,
      };
    }

    // Cupo: manda el plan vivo; el snapshot es el fallback si el plan se borro.
    const monthlyCredits =
      plan?.limits?.iaMonthlyCredits ??
      snapshot.limits?.iaMonthlyCredits ??
      0;
    const resetDay =
      plan?.limits?.iaResetDayUTC ?? snapshot.limits?.iaResetDayUTC ?? 1;

    const { start, end } = currentPeriod(resetDay);
    const consumed = await usageService.consumedTokens(
      companyId,
      start,
      new Date(),
    );
    const remaining = monthlyCredits - consumed;
    const blocked = consumed >= monthlyCredits;

    return {
      companyId,
      hasPlan: true,
      iaEnabled: true,
      blocked,
      reason: blocked ? "no_credits" : "ok",
      monthlyCredits,
      consumed,
      remaining,
      periodStart: start,
      periodEnd: end,
      planId: snapshot.planId,
      planName,
    };
  },

  /** Balance + decision de bloqueo, respetando el flag de enforcement. */
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

  /** Balance de varias companies (dashboard del plan en el panel interno). */
  async getCreditsForCompanies(companyIds: string[]): Promise<CompanyCredits[]> {
    return Promise.all(companyIds.map((id) => this.getCompanyCredits(id)));
  },
};

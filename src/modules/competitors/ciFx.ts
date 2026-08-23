/**
 * Tasas fijas para normalizar precios de competidores a USD (spec v2 §16).
 * Son aproximaciones editables con fecha: la nota de normalizacion dice la
 * tasa usada. Usar el connector `fx` del intelligence-hub (tasas reales) es un
 * paso chico posterior.
 */

export const FX_AS_OF = "2026-08";

// Unidades de moneda local por 1 USD.
const PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.78,
  ARS: 1450,
  BRL: 5.4,
  MXN: 18.5,
  CLP: 950,
  COP: 4100,
  PEN: 3.75,
  UYU: 41,
  PYG: 7500,
  BOB: 6.9,
  DOP: 60,
  CRC: 520,
  GTQ: 7.7,
};

export function knownCurrency(code: string | null | undefined): boolean {
  return Boolean(code && PER_USD[code.toUpperCase()]);
}

export function toUsd(amount: number | null | undefined, currency: string | null | undefined): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  const code = (currency || "USD").toUpperCase();
  const rate = PER_USD[code];
  if (!rate) return null;
  return Math.round((amount / rate) * 100) / 100;
}

export function fxRateNote(currency: string | null | undefined): string {
  const code = (currency || "USD").toUpperCase();
  if (code === "USD") return "";
  const rate = PER_USD[code];
  return rate ? `${code}→USD a ${rate} por USD (${FX_AS_OF})` : `${code}: sin tasa conocida`;
}

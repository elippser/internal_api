/**
 * Calendario del país: fines de semana largos, feriados, recesos escolares y
 * las ventanas de viaje de los mercados emisores.
 *
 * La confianza de un receso depende de dónde salió: OpenHolidays es oficial;
 * la tabla curada del Cono Sur es una REGLA que reproduce el último ciclo
 * publicado (`verified`) o una ventana estimada (`approximate`, los veranos).
 */

import type {
  CalendarPointPayload,
  LongWeekend,
  SchoolBreak,
} from "../../calendar/calendar.types";
import { addDaysIso, isoDay } from "../format";
import type {
  CalendarSlim,
  Confidence,
  EmitterWindowSlim,
  LongWeekendSlim,
  Projection,
  SchoolBreakSlim,
} from "../tourism.types";

export function schoolBreakConfidence(b: Pick<SchoolBreak, "source" | "precision">): Confidence {
  if (b.source === "openholidays") return "alta";
  return b.precision === "verified" ? "media" : "estimado";
}

const slimWeekend = (l: LongWeekend): LongWeekendSlim => ({
  startDate: l.startDate,
  endDate: l.endDate,
  dayCount: l.dayCount,
  needBridgeDay: l.needBridgeDay,
  holidays: l.holidays,
});

const slimBreak = (b: SchoolBreak): SchoolBreakSlim => ({
  startDate: b.startDate,
  endDate: b.endDate,
  name: b.name,
  blockLabel: b.blockLabel ?? null,
  nationwide: b.nationwide,
  confidence: schoolBreakConfidence(b),
});

export function projectCalendar(p: CalendarPointPayload | null, now: Date): Projection<CalendarSlim> {
  if (!p) return { data: null, missing: ["calendario y feriados"] };

  const today = isoDay(now);
  const d60 = addDaysIso(today, 60);
  const d90 = addDaysIso(today, 90);
  const d180 = addDaysIso(today, 180);
  const byStart = <T extends { startDate: string }>(a: T, b: T) => a.startDate.localeCompare(b.startDate);

  const emitters60d: EmitterWindowSlim[] = [];
  for (const em of p.emitters) {
    if (em.countryCode === p.location.countryCode) continue;
    for (const l of em.longWeekends) {
      if (l.startDate >= today && l.startDate <= d60) {
        emitters60d.push({
          countryCode: em.countryCode,
          countryName: em.countryName,
          kind: "fin_de_semana_largo",
          startDate: l.startDate,
          endDate: l.endDate,
          confidence: "alta",
        });
      }
    }
    for (const b of em.schoolBreaks) {
      if (b.startDate >= today && b.startDate <= d60) {
        emitters60d.push({
          countryCode: em.countryCode,
          countryName: em.countryName,
          kind: "receso_escolar",
          startDate: b.startDate,
          endDate: b.endDate,
          confidence: schoolBreakConfidence(b),
        });
      }
    }
  }

  const missing: string[] = [];
  if (!p.coverage.publicHolidays) missing.push("feriados oficiales");
  if (!p.coverage.longWeekends) missing.push("fines de semana largos");
  if (!p.coverage.schoolHolidays) missing.push("recesos escolares");

  return {
    data: {
      countryCode: p.location.countryCode,
      countryName: p.location.countryName,
      region: p.location.region,
      longWeekends: p.longWeekends
        .filter((l) => l.endDate >= today && l.startDate <= d180)
        .sort(byStart)
        .slice(0, 6)
        .map(slimWeekend),
      holidays90d: p.entries
        .filter((e) => e.kind === "public" && e.date >= today && e.date <= d90)
        .slice(0, 8)
        .map((e) => ({ date: e.date, name: e.name })),
      observances90d: p.entries
        .filter((e) => e.kind === "observance" && e.date >= today && e.date <= d90)
        .slice(0, 5)
        .map((e) => ({ date: e.date, name: e.name })),
      schoolBreaks: p.schoolBreaks
        .filter((b) => b.endDate >= today)
        .sort(byStart)
        .slice(0, 6)
        .map(slimBreak),
      emitters60d: emitters60d.sort(byStart).slice(0, 10),
    },
    missing,
  };
}

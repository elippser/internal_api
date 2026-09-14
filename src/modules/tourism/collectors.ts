/**
 * Un colector por hub: llama al servicio del hub EN PROCESO (sin HTTP, sin
 * secreto — corren en el mismo Express que el chat) y proyecta su payload.
 *
 * Los radios y ventanas son los de la pregunta del hotelero, no los defaults
 * del mapa: eventos a una hora de auto, el entorno a diez minutos a pie.
 *
 * Este archivo importa los ocho servicios de hub. Por eso `dossier.service`
 * lo carga recién cuando hace falta: los tests del módulo no tienen que
 * cargar la máscara de tierra ni los catálogos curados para correr.
 */

import { getCulturePoint } from "../culture/culture.service";
import { getSportsPoint } from "../sports/sports.service";
import { getMicePoint } from "../mice/mice.service";
import { getAttentionPoint } from "../attention/attention.service";
import { getCalendarPoint } from "../calendar/calendar.service";
import { getClimatePoint } from "../climate/climate.service";
import { getPlacePoint } from "../place/place.service";
import { getHazardsPoint } from "../hazards/hazards.service";
import { createLimiter } from "./limiter";
import { projectEvents } from "./facets/events";
import { projectAttention } from "./facets/attention";
import { projectCalendar } from "./facets/calendar";
import { projectClimate } from "./facets/climate";
import { projectPlace } from "./facets/place";
import { projectHazards } from "./facets/hazards";
import type { Projection, TourismHub } from "./tourism.types";

const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Eventos: lo que un huésped haría en auto por un evento. */
export const EVENTS_RADIUS_KM = envNum("TOURISM_EVENTS_RADIUS_KM", 100);
/** La cola larga del radar es de 90 días; las anclas se conocen con meses. */
export const EVENTS_MONTHS = 12;
/** La unidad del hub de entorno es la cuadra. */
export const PLACE_RADIUS_KM = 1;
export const HAZARDS_RADIUS_KM = 500;
export const HAZARDS_WINDOW_DAYS = 30;
export const ATTENTION_DAYS = 180;

export type HubCollector = (
  loc: { lat: number; lng: number },
  now: Date,
) => Promise<Projection<unknown>>;

/** Recibe cada payload crudo (para capturar fixtures desde el smoke). */
export type RawSink = (name: string, payload: unknown) => void;

// Compartidos por todas las propiedades del proceso. Open-Meteo va de a uno:
// su techo es por minuto y el archive es la llamada más pesada del catálogo.
const limits: Record<TourismHub, ReturnType<typeof createLimiter>> = {
  events: createLimiter(2),
  attention: createLimiter(2),
  calendar: createLimiter(2),
  climate: createLimiter(1),
  place: createLimiter(2),
  hazards: createLimiter(2),
};

const valueOf = <T>(r: PromiseSettledResult<T>): T | null =>
  r.status === "fulfilled" ? r.value : null;

const reasonOf = (r: PromiseSettledResult<unknown>): string =>
  r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : "";

export function createCollectors(opts: { onRaw?: RawSink } = {}): Record<TourismHub, HubCollector> {
  const raw = <T>(name: string, payload: T): T => {
    opts.onRaw?.(name, payload);
    return payload;
  };

  return {
    events: (loc, now) =>
      limits.events(async () => {
        const [culture, sports, mice] = await Promise.allSettled([
          getCulturePoint(loc.lat, loc.lng, EVENTS_RADIUS_KM, EVENTS_MONTHS).then((p) => raw("culture", p)),
          getSportsPoint(loc.lat, loc.lng, EVENTS_RADIUS_KM, EVENTS_MONTHS).then((p) => raw("sports", p)),
          getMicePoint(loc.lat, loc.lng, EVENTS_RADIUS_KM, EVENTS_MONTHS).then((p) => raw("mice", p)),
        ]);
        if (culture.status === "rejected" && sports.status === "rejected" && mice.status === "rejected") {
          throw new Error(`los tres hubs de eventos fallaron: ${reasonOf(culture)}`);
        }
        return projectEvents({
          culture: valueOf(culture),
          sports: valueOf(sports),
          mice: valueOf(mice),
          radiusKm: EVENTS_RADIUS_KM,
          now,
        });
      }),

    attention: (loc) =>
      limits.attention(async () =>
        projectAttention(raw("attention", await getAttentionPoint(loc.lat, loc.lng, ATTENTION_DAYS))),
      ),

    calendar: (loc, now) =>
      limits.calendar(async () =>
        projectCalendar(raw("calendar", await getCalendarPoint(loc.lat, loc.lng)), now),
      ),

    climate: (loc) =>
      limits.climate(async () => projectClimate(raw("climate", await getClimatePoint(loc.lat, loc.lng)))),

    place: (loc) =>
      limits.place(async () =>
        projectPlace(raw("place", await getPlacePoint(loc.lat, loc.lng, PLACE_RADIUS_KM))),
      ),

    hazards: (loc) =>
      limits.hazards(async () =>
        projectHazards(
          raw("hazards", await getHazardsPoint(loc.lat, loc.lng, HAZARDS_RADIUS_KM, HAZARDS_WINDOW_DAYS)),
        ),
      ),
  };
}

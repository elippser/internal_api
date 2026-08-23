// Sub-fuente Eventbrite API v3 (spec §3.2).
//
// LIMITACIÓN VERIFICADA (ago-2026): la búsqueda pública de eventos
// (/v3/events/search/) fue eliminada en feb-2020 y no tiene reemplazo — no
// existe forma soportada de descubrir eventos de terceros por ubicación.
// Con un private token solo se pueden listar los eventos de las
// organizaciones propias (o afiliadas al token). Eso es lo que hace esta
// sub-fuente; su cobertura depende de qué cuentas estén detrás del token.
//
// Auth: header Authorization: Bearer {EVENTBRITE_TOKEN}.

import { v4 as uuid } from "uuid";
import { fetchJson } from "../../core/http";
import { SOURCE_CONFIDENCE, type Signal } from "../../core/signal.types";

const EB_BASE = "https://www.eventbriteapi.com/v3";

interface EbOrganization {
  id: string;
  name?: string;
}

interface EbVenue {
  name?: string;
  latitude?: string;
  longitude?: string;
  address?: { city?: string; country?: string };
}

interface EbEvent {
  id: string;
  name?: { text?: string };
  url?: string;
  start?: { utc?: string; local?: string };
  end?: { utc?: string; local?: string };
  capacity?: number;
  venue?: EbVenue;
  status?: string;
}

interface EbPaginated<T> {
  pagination?: { has_more_items?: boolean; continuation?: string };
  organizations?: T[];
  events?: T[];
}

export function isEventbriteConfigured(): boolean {
  return Boolean(process.env.EVENTBRITE_TOKEN);
}

export async function fetchEventbriteSignals(): Promise<{
  signals: Signal[];
  errors: string[];
}> {
  const token = process.env.EVENTBRITE_TOKEN;
  if (!token) return { signals: [], errors: ["EVENTBRITE_TOKEN no configurado"] };

  const headers = { Authorization: `Bearer ${token}` };
  const signals: Signal[] = [];
  const errors: string[] = [];

  let organizations: EbOrganization[] = [];
  try {
    const res = await fetchJson<EbPaginated<EbOrganization>>(
      `${EB_BASE}/users/me/organizations/`,
      { headers },
    );
    organizations = res.organizations ?? [];
  } catch (err) {
    return { signals: [], errors: [`organizations: ${(err as Error).message}`] };
  }

  for (const org of organizations) {
    try {
      const res = await fetchJson<EbPaginated<EbEvent>>(
        `${EB_BASE}/organizations/${org.id}/events/?status=live&time_filter=current_future&expand=venue`,
        { headers },
      );
      for (const ev of res.events ?? []) {
        const signal = normalizeEbEvent(ev, org);
        if (signal) signals.push(signal);
      }
    } catch (err) {
      errors.push(`org ${org.id}: ${(err as Error).message}`);
    }
  }

  return { signals, errors };
}

function normalizeEbEvent(ev: EbEvent, org: EbOrganization): Signal | null {
  const lat = ev.venue?.latitude ? Number(ev.venue.latitude) : undefined;
  const lng = ev.venue?.longitude ? Number(ev.venue.longitude) : undefined;
  const start = ev.start?.utc;
  if (!start) return null;

  // Sin capacity conocida: 0.3 (evento auto-publicado chico por defecto).
  // Con capacity: 2000 asistentes ≈ techo de la escala.
  const magnitude = ev.capacity
    ? Math.min(1, ev.capacity / 2000)
    : 0.3;

  return {
    id: uuid(),
    type: "event",
    source: "eventbrite",
    scope: {
      geo: {
        lat,
        lng,
        countryCode: ev.venue?.address?.country,
        city: ev.venue?.address?.city,
      },
    },
    timeWindow: { start, end: ev.end?.utc ?? start },
    magnitude,
    confidence: SOURCE_CONFIDENCE.eventbrite,
    rawPayload: {
      providerId: ev.id,
      name: ev.name?.text ?? null,
      url: ev.url,
      capacity: ev.capacity ?? null,
      venue: ev.venue?.name ?? null,
      organizationId: org.id,
      organizationName: org.name ?? null,
    },
    ingestedAt: "",
    dedupeKey: `event:eb:${ev.id}`,
  };
}

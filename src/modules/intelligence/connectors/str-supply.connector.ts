// Connector STR Supply (RADAR-DEMAND-DATA-SPEC.md #13): presión de oferta
// alternativa (Airbnb) agregada por barrio, vía los dumps trimestrales de
// InsideAirbnb (gratis, sin key). Para revenue interesa doble: cuánta
// oferta STR compite con el hotel en su barrio, y qué tan ocupada está —
// reviews_per_month es el proxy de ocupación estándar de la propia fuente.
//
// Flujo: 1 request a get-the-data (descubre la fecha del último snapshot
// por ciudad) + 1 CSV (~2-5 MB) por ciudad configurada. Un Signal por
// barrio con centroide, mediana de precio (moneda local), listings y proxy
// de ocupación. Cadencia mensual (los dumps son trimestrales); primera
// carga: POST /api/v1/intelligence/ingest/str-supply.

import { v4 as uuid } from "uuid";
import { STR_CONFIG } from "../core/intelligence.config";
import { fetchText } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const DATA_PAGE = "https://insideairbnb.com/get-the-data/";

// Parser CSV RFC 4180 mínimo: comillas, comillas escapadas ("") y saltos de
// línea dentro de campos (los nombres de listings los traen seguido).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

// data.insideairbnb.com/<país>/<región>/<slug>/<fecha>/visualisations/listings.csv
// El get-the-data lista todos los snapshots; nos quedamos con la fecha más
// reciente por slug configurado.
export function findLatestCsvUrls(html: string, slugs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const re = /https:\/\/data\.insideairbnb\.com\/[^\s"']+\/([a-z-]+)\/(\d{4}-\d{2}-\d{2})\/visualisations\/listings\.csv/g;
  const wanted = new Set(slugs);
  let m: RegExpExecArray | null;
  const latest = new Map<string, { date: string; url: string }>();
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    if (!wanted.has(slug)) continue;
    const prev = latest.get(slug);
    if (!prev || m[2] > prev.date) latest.set(slug, { date: m[2], url: m[0] });
  }
  for (const [slug, v] of latest) out.set(slug, v.url);
  return out;
}

const parsePrice = (raw: string): number | null => {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

interface HoodAgg {
  count: number;
  lats: number[];
  lngs: number[];
  prices: number[];
  reviewsPerMonth: number[];
  availability: number[];
  entireHomes: number;
}

export function createStrSupplyConnector(): Connector {
  return {
    name: "str-supply",

    async healthCheck() {
      try {
        const html = await fetchText(DATA_PAGE, { retries: 0, timeoutMs: 20_000 });
        const found = findLatestCsvUrls(html, STR_CONFIG.cities.map((c) => c.slug));
        return {
          ok: found.size > 0,
          detail: `insideairbnb OK: ${found.size}/${STR_CONFIG.cities.length} ciudades con snapshot`,
        };
      } catch (err) {
        return { ok: false, detail: `insideairbnb inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const signals: Signal[] = [];
      const errors: string[] = [];
      const perCity: Record<string, number> = {};

      const dataPage = await fetchText(DATA_PAGE, { timeoutMs: 30_000 });
      const urls = findLatestCsvUrls(dataPage, STR_CONFIG.cities.map((c) => c.slug));

      for (const city of STR_CONFIG.cities) {
        const url = urls.get(city.slug);
        if (!url) {
          errors.push(`${city.label}: sin snapshot en get-the-data`);
          continue;
        }
        try {
          const csv = await fetchText(url, { timeoutMs: 120_000, retries: 1 });
          const rows = parseCsv(csv);
          if (rows.length < 2) throw new Error("CSV vacío");
          const header = rows[0].map((h) => h.trim().toLowerCase());
          const col = (name: string) => header.indexOf(name);
          const iHood = col("neighbourhood");
          const iHoodGroup = col("neighbourhood_group");
          const iLat = col("latitude");
          const iLng = col("longitude");
          const iRoom = col("room_type");
          const iPrice = col("price");
          const iRpm = col("reviews_per_month");
          const iAvail = col("availability_365");
          if (iLat < 0 || iLng < 0) throw new Error("CSV sin columnas latitude/longitude");

          const snapshotDate = (url.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? new Date().toISOString().slice(0, 10);
          const hoods = new Map<string, HoodAgg>();

          for (const r of rows.slice(1)) {
            const lat = Number(r[iLat]);
            const lng = Number(r[iLng]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            const hood =
              (iHood >= 0 && r[iHood]?.trim()) ||
              (iHoodGroup >= 0 && r[iHoodGroup]?.trim()) ||
              "—";
            let agg = hoods.get(hood);
            if (!agg) {
              agg = { count: 0, lats: [], lngs: [], prices: [], reviewsPerMonth: [], availability: [], entireHomes: 0 };
              hoods.set(hood, agg);
            }
            agg.count++;
            agg.lats.push(lat);
            agg.lngs.push(lng);
            const price = iPrice >= 0 ? parsePrice(r[iPrice] ?? "") : null;
            if (price !== null) agg.prices.push(price);
            const rpm = iRpm >= 0 ? Number(r[iRpm]) : NaN;
            agg.reviewsPerMonth.push(Number.isFinite(rpm) ? rpm : 0);
            const avail = iAvail >= 0 ? Number(r[iAvail]) : NaN;
            if (Number.isFinite(avail)) agg.availability.push(avail);
            if (iRoom >= 0 && /entire/i.test(r[iRoom] ?? "")) agg.entireHomes++;
          }

          let produced = 0;
          for (const [hood, agg] of hoods) {
            if (agg.count < STR_CONFIG.minListingsPerHood) continue;
            const centroidLat = agg.lats.reduce((a, b) => a + b, 0) / agg.lats.length;
            const centroidLng = agg.lngs.reduce((a, b) => a + b, 0) / agg.lngs.length;
            const avgRpm =
              agg.reviewsPerMonth.reduce((a, b) => a + b, 0) / agg.reviewsPerMonth.length;
            const avgAvail = agg.availability.length
              ? agg.availability.reduce((a, b) => a + b, 0) / agg.availability.length
              : null;

            signals.push({
              id: uuid(),
              type: "str_supply",
              source: "insideairbnb",
              scope: {
                geo: { lat: centroidLat, lng: centroidLng, countryCode: city.countryCode, city: city.label },
              },
              timeWindow: {
                start: `${snapshotDate}T00:00:00Z`,
                end: new Date(
                  new Date(`${snapshotDate}T00:00:00Z`).getTime() +
                    STR_CONFIG.windowDays * 86_400_000,
                ).toISOString(),
              },
              // ~2.5 reviews/mes ≈ ocupación muy alta (proxy InsideAirbnb).
              magnitude: Math.min(1, Math.max(0.05, avgRpm / 2.5)),
              confidence: SOURCE_CONFIDENCE.insideairbnb,
              rawPayload: {
                neighbourhood: hood,
                listings: agg.count,
                medianPriceLocal: median(agg.prices),
                avgReviewsPerMonth: Number(avgRpm.toFixed(2)),
                avgAvailability365: avgAvail !== null ? Math.round(avgAvail) : null,
                entireHomeShare: Number((agg.entireHomes / agg.count).toFixed(2)),
                snapshotDate,
                sourceUrl: url,
              },
              ingestedAt: "",
              dedupeKey: `str:${city.slug}:${hood
                .toLowerCase()
                .normalize("NFD")
                .replace(/[̀-ͯ]/g, "")
                .replace(/ñ/g, "n")
                .replace(/\s+/g, "-")
                .replace(/[^a-z0-9-]/g, "")
                .slice(0, 60)}`,
            });
            produced++;
          }
          perCity[city.label] = produced;
        } catch (err) {
          errors.push(`${city.label}: ${(err as Error).message}`);
        }
      }

      return {
        signals,
        meta: {
          cities: STR_CONFIG.cities.length,
          perCity,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}

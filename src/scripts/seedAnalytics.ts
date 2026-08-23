import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { AnalyticsEvent } from "../modules/analytics/analytics.model";

/**
 * ⚠️ Datos SINTÉTICOS para desarrollo. Durante mucho tiempo fue el único
 * productor de `analytics_events` (no había instrumentación en ninguna app),
 * así que los dashboards de /analytics y las métricas de actividad de /hotels
 * mostraban esto y no uso real.
 *
 * Con la instrumentación real encendida, NO correr contra una base con datos
 * de verdad: mezcla lo inventado con lo medido y no hay forma de separarlos
 * después salvo por las companies ficticias de abajo.
 * Para limpiar: `npm run purge:seeded-analytics`.
 */

const COMPANIES = ["co-001", "co-002", "co-003", "co-004", "co-005", "co-006", "co-007", "co-008"];
const PROPERTIES = ["prop-aa", "prop-bb", "prop-cc", "prop-dd", "prop-ee"];
const APPS = ["pms-core", "booking-app", "rooms-app", "web-renderer", "staypass"];
const COMPONENTS = [
  "HeroBanner",
  "RoomCategoriesSection",
  "MapsEmbed",
  "TextBlock",
  "GalleryGrid",
  "TestimonialsCarousel",
  "ContactForm",
  "FAQAccordion",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickWeighted<T>(arr: T[]): T {
  const idx = Math.floor(Math.pow(Math.random(), 1.6) * arr.length);
  return arr[Math.min(idx, arr.length - 1)];
}

function dateInLastDays(days: number): Date {
  const now = Date.now();
  const offset = Math.floor(Math.random() * days * 24 * 60 * 60 * 1000);
  return new Date(now - offset);
}

interface EventInput {
  eventName: string;
  category: string;
  source: string;
  companyId: string;
  propertyId?: string | null;
  payload?: Record<string, unknown>;
  ts: Date;
  sessionId?: string;
}

function build(input: EventInput) {
  return {
    eventName: input.eventName,
    category: input.category,
    source: input.source,
    companyId: input.companyId,
    propertyId: input.propertyId ?? null,
    userId: null,
    sessionId: input.sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`,
    userRole: null,
    payload: input.payload ?? {},
    clientTimestamp: input.ts,
    serverTimestamp: input.ts,
  };
}

async function seed() {
  await connectDB();

  const existing = await AnalyticsEvent.countDocuments();
  if (existing > 0) {
    console.log(`• Ya hay ${existing} eventos analytics; skip (borralos manual si queres regenerar)`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const events: ReturnType<typeof build>[] = [];

  // app_opened — distribuido por appId y company (para adoption)
  for (let i = 0; i < 800; i++) {
    const co = pick(COMPANIES);
    const appId = pickWeighted(APPS);
    events.push(
      build({
        eventName: "app_opened",
        category: "session",
        source: appId,
        companyId: co,
        payload: { appId },
        ts: dateInLastDays(45),
      }),
    );
  }

  // app_session_ended — engagement (durationSeconds)
  for (let i = 0; i < 600; i++) {
    const co = pick(COMPANIES);
    const appId = pickWeighted(APPS);
    const duration = Math.round(20 + Math.random() * 1200); // 20s a 20min
    events.push(
      build({
        eventName: "app_session_ended",
        category: "session",
        source: appId,
        companyId: co,
        payload: { appId, durationSeconds: duration },
        ts: dateInLastDays(45),
      }),
    );
  }

  // Funnel del motor — 5 pasos, con dropoff realista
  const funnelSteps = [
    { name: "engine_search_initiated", drop: 1.0 },
    { name: "engine_results_viewed", drop: 0.7 },
    { name: "engine_category_selected", drop: 0.45 },
    { name: "engine_auth_completed", drop: 0.25 },
    { name: "engine_reservation_created", drop: 0.12 },
  ];
  const totalSearches = 400;
  for (let i = 0; i < totalSearches; i++) {
    const co = pick(COMPANIES);
    const prop = pick(PROPERTIES);
    const ts = dateInLastDays(45);
    const session = `sess-${Math.random().toString(36).slice(2, 10)}`;
    const hasAvailability = Math.random() > 0.18;
    for (const step of funnelSteps) {
      if (Math.random() < step.drop) {
        events.push(
          build({
            eventName: step.name,
            category: "engine",
            source: "booking-app",
            companyId: co,
            propertyId: prop,
            sessionId: session,
            payload:
              step.name === "engine_search_initiated"
                ? { hasAvailability, propertySlug: prop }
                : { propertySlug: prop },
            ts,
          }),
        );
      } else {
        break;
      }
    }
  }

  // site_published — para builder cards y summary
  for (const co of COMPANIES) {
    if (Math.random() > 0.3) {
      events.push(
        build({
          eventName: "site_published",
          category: "builder",
          source: "pms-core",
          companyId: co,
          payload: {},
          ts: dateInLastDays(60),
        }),
      );
    }
  }

  // builder activity
  for (let i = 0; i < 300; i++) {
    const co = pick(COMPANIES);
    const event = Math.random() > 0.5 ? "builder_page_edited" : "builder_component_added";
    events.push(
      build({
        eventName: event,
        category: "builder",
        source: "pms-core",
        companyId: co,
        payload: event === "builder_component_added" ? { componentType: pickWeighted(COMPONENTS) } : {},
        ts: dateInLastDays(45),
      }),
    );
  }

  await AnalyticsEvent.insertMany(events);
  console.log(`✓ Insertados ${events.length} eventos analytics mock`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seedAnalytics] error:", err);
  process.exit(1);
});

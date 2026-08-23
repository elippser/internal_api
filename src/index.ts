import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { connectDB } from "./shared/db";
import { stubRouter } from "./shared/stubRouter";
import { fail } from "./shared/utils/http";

import { authRouter } from "./modules/auth/auth.router";
import { usersRouter } from "./modules/users/users.router";
import { analyticsRouter } from "./modules/analytics/analytics.router";
import { metricsRouter } from "./modules/metrics/metrics.router";
import { agentsRouter } from "./modules/agents/agents.router";
import { toolsRouter } from "./modules/tools/tools.router";
import { knowledgeRouter } from "./modules/knowledge/knowledge.router";
import { feedbackRouter } from "./modules/feedback/feedback.router";
import { conversationsRouter } from "./modules/conversations/conversations.router";
import { startSessionExpiryJob } from "./modules/conversations/services/sessionExpiryJob";
import { ticketsRouter } from "./modules/tickets/tickets.router";
import { startTicketingCron } from "./modules/tickets/ticketingCron";
import { startMetricsCron } from "./modules/metrics/metricsCron";
import { hotelsRouter } from "./modules/hotels/hotels.router";
import { accessRouter } from "./modules/access/access.router";
import { usageRouter } from "./modules/usage/usage.router";
import { contractsRouter } from "./modules/contracts/contracts.router";
import { plansRouter, publicPlansRouter } from "./modules/plans/plans.router";
import { plansCodeRouter } from "./modules/plans/planscode.router";
import { memoryRouter } from "./modules/memory/memory.router";
import { systemRouter } from "./modules/system/system.router";
import { intelligenceRouter } from "./modules/intelligence/intelligence.router";
import { startIntelligenceCron } from "./modules/intelligence/intelligenceCron";
import { crmRouter } from "./modules/crm/crm.router";
import { startCrmCron } from "./modules/crm/crmCron";
import { registerEventConsumer } from "./modules/crm/crm.service";
import { segmentsService } from "./modules/crm/segments.service";
import { campaignsRouter } from "./modules/campaigns/campaigns.router";
import { campaignsService } from "./modules/campaigns/campaigns.service";
import { startCampaignsCron } from "./modules/campaigns/campaignsCron";
import {
  mktsiteRouter,
  publicLeadRouter,
  publicSiteRouter,
} from "./modules/mktsite/mktsite.router";
import { mktprojectRouter } from "./modules/mktproject/mktproject.router";
import { dnsRouter } from "./modules/dns/dns.router";
import { infraRouter } from "./modules/infra/infra.router";
import {
  publicNpsRouter,
  reputationRouter,
} from "./modules/reputation/reputation.router";
import { loyaltyRouter } from "./modules/loyalty/loyalty.router";
import { competitorsRouter } from "./modules/competitors/competitors.router";
import { prospectsRouter } from "./modules/prospects/prospects.router";
import { startRadarCron } from "./modules/competitors/radar/radarCron";
import { startSignalsCron } from "./modules/competitors/signals/signalsCron";
import { startMentionDetectorCron } from "./modules/competitors/mentions/mentionDetector";
import { globalRouter } from "./modules/global/global.router";
import { engineRouter } from "./modules/engine/engine.router";
import { bootstrapEngine, shutdownWorker } from "./engine";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.WEB_URL ?? "http://localhost:8500",
    credentials: true,
  }),
);
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

const BASE = "/api/v1";
app.use(`${BASE}/auth`, authRouter);
app.use(`${BASE}/users`, usersRouter);
app.use(`${BASE}/analytics`, analyticsRouter);
app.use(`${BASE}/metrics`, metricsRouter);
app.use(`${BASE}/agents`, agentsRouter);
app.use(`${BASE}/tools`, toolsRouter);
app.use(`${BASE}/knowledge`, knowledgeRouter);
app.use(`${BASE}/feedback`, feedbackRouter);
app.use(`${BASE}/conversations`, conversationsRouter);
app.use(`${BASE}/tickets`, ticketsRouter);
app.use(`${BASE}/hotels`, hotelsRouter);
app.use(`${BASE}/access`, accessRouter);
app.use(`${BASE}/usage`, usageRouter);
app.use(`${BASE}/contracts`, contractsRouter);
// Planes y productos comerciales. El PMS los consume via /plans/internal/*
// con X-Internal-Secret para armar la pantalla de eleccion del alta.
// El workspace va ANTES: montado despues, /plans lo captura primero y "code"
// se lee como un planId (404 "Plan no encontrado").
app.use(`${BASE}/plans/code`, plansCodeRouter);
app.use(`${BASE}/plans`, plansRouter);
app.use(`${BASE}/memory`, memoryRouter);
app.use(`${BASE}/system`, systemRouter);
app.use(`${BASE}/intelligence`, intelligenceRouter);
app.use(`${BASE}/crm`, crmRouter);
app.use(`${BASE}/campaigns`, campaignsRouter);
// El sitio publico es un repo Next (public-side/mkt-renderer) y se edita como
// un proyecto, no como filas de una coleccion. /mkt/site queda para los pixels,
// las conversiones y la captura de leads, que siguen viviendo en la DB.
app.use(`${BASE}/mkt/project`, mktprojectRouter);
app.use(`${BASE}/mkt/site`, mktsiteRouter);
// DNS de bookfer.com en Cloudflare. Vive bajo /mkt porque el dominio es del
// sitio publico, pero lo que administra es la zona entera de la plataforma:
// los 17 hostnames de DNS-CLOUDFLARE-BOOKFER.md salen de los .env.production.
app.use(`${BASE}/mkt/dns`, dnsRouter);
// Infraestructura: que servicio del stack corre en que proveedor y con que
// deploy. Prefijo propio y no bajo /mkt como DNS — la zona es del dominio del
// sitio publico, pero esto es el stack entero (Vercel + Coolify). Solo lectura.
app.use(`${BASE}/infra`, infraRouter);
app.use(`${BASE}/reputation`, reputationRouter);
app.use(`${BASE}/loyalty`, loyaltyRouter);

// Inteligencia competitiva de bookfer: battle set (Tier 1) + radar (Tier 2).
// Ver COMPETITIVE-INTEL-SPEC.md.
app.use(`${BASE}/competitors`, competitorsRouter);

// Prospectos: la lista de alojamientos a llamar. Va antes del CRM en el
// recorrido comercial (todavia no hay conversacion, asi que no hay cuenta).
app.use(`${BASE}/prospects`, prospectsRouter);

// Motor agéntico. Prefijo propio a proposito: /agents y /conversations siguen
// sirviendo al runtime actual del chat del PMS sin un solo cambio, y los dos
// agentes existentes se migran cuando el motor este validado con trafico real.
app.use(`${BASE}/engine`, engineRouter);

// Superficie publica del hub de marketing: el sitio de bookfer, el formulario
// de captura y la encuesta NPS. Van fuera de /api/v1 porque no llevan JWT y las
// consume gente de afuera (o Google, al indexar el sitio).
app.use("/public/mkt/leads", publicLeadRouter);
// El catalogo de planes que pinta <PlansMkt/> en el sitio de bookfer.
app.use("/public/plans", publicPlansRouter);
app.use("/public/mkt/nps", publicNpsRouter);
app.use("/s", publicSiteRouter);

// Feeds de elippser para la vista /global. Van fuera de /api/v1 porque son
// los route handlers portados tal cual desde elippser-gl y conservan sus
// propios paths. Relajamos CORP: el mapa carga tiles e imagenes de estas
// rutas desde el origen del front, que en produccion es otro host.
app.use(
  "/api/global",
  (_req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  globalRouter,
);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((_req, res) => {
  fail(res, 404, "Ruta no encontrada", "not_found");
});

app.use(
  (
    err: Error & { status?: number },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction,
  ) => {
    console.error("[internal] unhandled error:", err);
    fail(res, err.status ?? 500, err.message ?? "Internal Server Error");
  },
);

const PORT = Number(process.env.PORT ?? 8600);

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[internal] API running on :${PORT}`);
    });
    startSessionExpiryJob();
    startTicketingCron();
    startMetricsCron();

    // El motor arranca DESPUES de conectar: el worker empieza a reclamar de
    // inmediato y sin conexion solo produciria ruido de errores. Es idempotente
    // y tolerante: cada paso esta envuelto y solo advierte si falla.
    const engine = bootstrapEngine();
    if (engine.problems.length > 0) {
      console.warn(
        `[engine] arranco con ${engine.problems.length} advertencia(s):`,
        engine.problems,
      );
    }
    startIntelligenceCron();
    startCrmCron();
    startCampaignsCron();
    startRadarCron();
    startSignalsCron();
    startMentionDetectorCron();

    // El outbox del CRM encola los mensajes de los templates que reaccionan a
    // cada evento. Se engancha acá y no con un import directo porque
    // `campaigns` ya depende de `crm` (segmentos y contactos).
    registerEventConsumer((evt) => campaignsService.enqueueForEvent(evt));

    // Segmentos base: sin ellos el tablero arranca vacío y no se entiende.
    segmentsService
      .ensureSystemSegments()
      .then((r) => {
        if (r.created > 0) console.log(`[crm] ${r.created} segmentos del sistema creados`);
      })
      .catch((err) => console.error("[crm] segmentos del sistema:", err?.message ?? err));
  })
  .catch((err) => {
    console.error("[internal] failed to connect MongoDB:", err);
    process.exit(1);
  });

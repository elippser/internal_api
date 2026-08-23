import crypto from "crypto";
import { makeId } from "../../shared/utils/ids";
import { crmService } from "../crm/crm.service";
import { MktAccount, MktContact, domainOf } from "../crm/crm.model";
import {
  MktConversion,
  MktPage,
  MktSite,
  sanitize,
  sanitizeSite,
} from "./mktsite.model";

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

/** Meta y Google exigen los datos de contacto hasheados. */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const mktsiteService = {
  // ---------- Sitios ----------

  async listSites() {
    const sites = await MktSite.find().sort({ createdAt: -1 }).lean();
    return Promise.all(
      sites.map(async (s) => ({
        ...sanitizeSite(s),
        pageCount: await MktPage.countDocuments({ siteId: s.siteId }),
      })),
    );
  },

  async getSite(siteId: string) {
    const site = await MktSite.findOne({ siteId }).lean();
    if (!site) throw httpError(404, "Sitio no encontrado", "not_found");
    const pages = await MktPage.find({ siteId }).sort({ path: 1 }).lean();
    return { ...sanitizeSite(site), pages: pages.map(sanitize) };
  },

  async createSite(input: Record<string, any>, userId: string) {
    const slug = String(input.slug ?? input.name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) throw httpError(400, "El slug no puede quedar vacio", "invalid_slug");

    const dup = await MktSite.findOne({ slug }).lean();
    if (dup) throw httpError(409, "Ya existe un sitio con ese slug", "duplicate");

    const site = await MktSite.create({
      ...input,
      slug,
      siteId: makeId("site"),
      createdByUserId: userId,
    });

    // Un sitio sin home no se puede previsualizar; se crea una de arranque.
    await MktPage.create({
      pageId: makeId("page"),
      siteId: site.siteId,
      name: "Inicio",
      path: "/",
      html: `<main style="font-family:system-ui;max-width:640px;margin:80px auto;padding:0 24px">
  <h1>${escapeHtml(String(input.name ?? "Nuevo sitio"))}</h1>
  <p>Editá esta página desde la pestaña <strong>Content</strong>.</p>
</main>`,
    });

    return sanitizeSite(site.toObject());
  },

  async updateSite(siteId: string, patch: Record<string, any>) {
    // Un token vacio o el centinela no pisan el guardado: solo se escribe
    // cuando llega uno nuevo de verdad.
    if (patch.pixels) {
      const token = patch.pixels.metaCapiToken;
      if (!token || token === "__set__") delete patch.pixels.metaCapiToken;
    }

    const doc = await MktSite.findOneAndUpdate(
      { siteId },
      { $set: flatten(patch) },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Sitio no encontrado", "not_found");
    return sanitizeSite(doc);
  },

  async deleteSite(siteId: string) {
    const res = await MktSite.deleteOne({ siteId });
    if (res.deletedCount === 0) throw httpError(404, "Sitio no encontrado", "not_found");
    await MktPage.deleteMany({ siteId });
    return { deleted: true };
  },

  // ---------- Paginas ----------

  async getPage(pageId: string) {
    const page = await MktPage.findOne({ pageId }).lean();
    if (!page) throw httpError(404, "Pagina no encontrada", "not_found");
    return sanitize(page);
  },

  async createPage(siteId: string, input: Record<string, any>) {
    const site = await MktSite.findOne({ siteId }).lean();
    if (!site) throw httpError(404, "Sitio no encontrado", "not_found");

    const path = normalizePath(input.path ?? "/");
    const dup = await MktPage.findOne({ siteId, path }).lean();
    if (dup) throw httpError(409, "Ya existe una pagina en esa ruta", "duplicate");

    const doc = await MktPage.create({
      ...input,
      path,
      pageId: makeId("page"),
      siteId,
    });
    return sanitize(doc.toObject());
  },

  async updatePage(pageId: string, patch: Record<string, any>) {
    if (patch.path) patch.path = normalizePath(patch.path);
    const doc = await MktPage.findOneAndUpdate(
      { pageId },
      { $set: flatten(patch) },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Pagina no encontrada", "not_found");
    return sanitize(doc);
  },

  async deletePage(pageId: string) {
    const res = await MktPage.deleteOne({ pageId });
    if (res.deletedCount === 0) throw httpError(404, "Pagina no encontrada", "not_found");
    return { deleted: true };
  },

  /** Congela el borrador como lo que ve el publico. */
  async publishPage(pageId: string) {
    const page = await MktPage.findOne({ pageId });
    if (!page) throw httpError(404, "Pagina no encontrada", "not_found");

    page.set("publishedHtml", page.html);
    page.set("publishedCss", page.css);
    page.set("publishedJs", page.js);
    page.set("publishedAt", new Date());
    page.set("status", "published");
    await page.save();
    return sanitize(page.toObject());
  },

  async unpublishPage(pageId: string) {
    const doc = await MktPage.findOneAndUpdate(
      { pageId },
      { $set: { status: "draft" }, $unset: { publishedHtml: "", publishedAt: "" } },
      { new: true },
    ).lean();
    if (!doc) throw httpError(404, "Pagina no encontrada", "not_found");
    return sanitize(doc);
  },

  // ---------- Render publico ----------

  /**
   * Arma el documento completo. `preview` sirve el borrador (para el iframe del
   * editor); sin el, solo se sirve lo publicado.
   */
  async renderPage(slug: string, path: string, preview = false) {
    const site = await MktSite.findOne({ slug }).lean();
    if (!site) throw httpError(404, "Sitio no encontrado", "not_found");
    if (!preview && site.status !== "published") {
      throw httpError(404, "El sitio no esta publicado", "not_published");
    }

    const page = await MktPage.findOne({
      siteId: site.siteId,
      path: normalizePath(path),
    }).lean();
    if (!page) throw httpError(404, "Pagina no encontrada", "not_found");

    const body = preview ? page.html : page.publishedHtml;
    if (!body) throw httpError(404, "La pagina no esta publicada", "not_published");

    const css = preview ? page.css : page.publishedCss;
    const js = preview ? page.js : page.publishedJs;
    return buildHtmlDocument({
      site,
      page,
      body,
      css: css ?? "",
      js: js ?? "",
      preview,
    });
  },

  // ---------- Captura de leads ----------

  /**
   * Form publico del sitio. Crea o reusa la cuenta y su contacto, y deja el
   * evento `lead.captured` para que el outbox dispare lo que corresponda.
   */
  async captureLead(input: {
    name?: string;
    email: string;
    phone?: string;
    company?: string;
    message?: string;
    siteId?: string;
    utm?: Record<string, string>;
  }) {
    const email = input.email.toLowerCase().trim();
    const existing = await MktContact.findOne({ email }).lean();

    let accountId: string;
    let isNew = false;

    if (existing) {
      accountId = existing.accountId;
    } else {
      const accountName = input.company?.trim() || email.split("@")[1] || email;
      const website = input.company?.includes(".") ? input.company : undefined;
      const websiteDomain = domainOf(website);

      // Si el dominio ya es de una cuenta conocida, el lead entra ahi en vez de
      // abrir una cuenta nueva duplicada.
      const byDomain = websiteDomain
        ? await MktAccount.findOne({ websiteDomain }).lean()
        : null;

      if (byDomain) {
        accountId = byDomain.accountId;
      } else {
        const account = await MktAccount.create({
          accountId: makeId("acc"),
          name: accountName,
          website,
          websiteDomain,
          lifecycle: "lead",
          source: "website",
          notes: input.message ?? "",
          optIn: { email: true, whatsapp: Boolean(input.phone), updatedAt: new Date() },
          lifecycleChangedAt: new Date(),
        });
        accountId = account.accountId;
        isNew = true;
      }

      await MktContact.create({
        contactId: makeId("cnt"),
        accountId,
        email,
        phone: input.phone,
        firstName: input.name,
        isPrimary: isNew,
        // Quien deja sus datos en el formulario esta pidiendo que lo contacten.
        optIn: { email: true, whatsapp: Boolean(input.phone), updatedAt: new Date() },
      });
    }

    await crmService.ingestEvent({
      type: "lead.captured",
      correlationId: `lead:${email}:${Date.now()}`,
      accountId,
      payload: {
        siteId: input.siteId,
        message: input.message,
        utm: input.utm ?? {},
      },
      source: "website",
    });

    return { accountId, isNewAccount: isNew };
  },

  // ---------- Conversiones server-side ----------

  /**
   * Registra la conversion y la manda a Meta CAPI / Google Ads.
   *
   * Va server-side porque los bloqueadores de publicidad se comen una parte de
   * los eventos del navegador. `eventIdShared` es el que permite que Meta
   * deduplique contra el pixel del cliente cuando llegan los dos.
   */
  async trackConversion(input: {
    siteId?: string;
    accountId?: string;
    eventName: string;
    eventId?: string;
    email?: string;
    phone?: string;
    value?: number;
    currency?: string;
  }) {
    const conversion = await MktConversion.create({
      conversionId: makeId("conv"),
      siteId: input.siteId,
      accountId: input.accountId,
      eventName: input.eventName,
      eventIdShared: input.eventId ?? makeId("ev"),
      value: input.value ?? 0,
      currency: input.currency ?? "USD",
      hashedEmail: input.email ? sha256(input.email) : undefined,
      hashedPhone: input.phone ? sha256(input.phone) : undefined,
    });

    const site = input.siteId ? await MktSite.findOne({ siteId: input.siteId }).lean() : null;
    const destinations: string[] = [];
    const errors: string[] = [];

    if (site?.pixels?.metaPixelId && site.pixels.metaCapiToken) {
      try {
        await sendMetaCapi(site.pixels.metaPixelId, site.pixels.metaCapiToken, {
          eventName: conversion.eventName,
          eventId: conversion.eventIdShared,
          hashedEmail: conversion.hashedEmail ?? undefined,
          hashedPhone: conversion.hashedPhone ?? undefined,
          value: conversion.value,
          currency: conversion.currency,
        });
        destinations.push("meta");
      } catch (err: any) {
        errors.push(`meta: ${err?.message ?? err}`);
      }
    }

    conversion.set("destinations", destinations);
    conversion.set("status", errors.length && !destinations.length ? "failed" : "sent");
    if (errors.length) conversion.set("error", errors.join(" | ").slice(0, 500));
    conversion.set("sentAt", new Date());
    await conversion.save();

    return sanitize(conversion.toObject());
  },

  async listConversions(limit = 100) {
    const rows = await MktConversion.find().sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map(sanitize);
  },
};

// ---------------------------------------------------------------------------

async function sendMetaCapi(
  pixelId: string,
  token: string,
  ev: {
    eventName: string;
    eventId: string;
    hashedEmail?: string;
    hashedPhone?: string;
    value: number;
    currency: string;
  },
) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            event_name: ev.eventName,
            event_time: Math.floor(Date.now() / 1000),
            event_id: ev.eventId,
            action_source: "website",
            user_data: {
              ...(ev.hashedEmail ? { em: [ev.hashedEmail] } : {}),
              ...(ev.hashedPhone ? { ph: [ev.hashedPhone] } : {}),
            },
            custom_data: { value: ev.value, currency: ev.currency },
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

function normalizePath(p: string): string {
  const trimmed = String(p ?? "/").trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : "/";
}

/** Aplana un patch anidado a notacion de puntos para no pisar el subdocumento entero. */
function flatten(obj: Record<string, any>, prefix = ""): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function buildHtmlDocument(args: {
  site: any;
  page: any;
  body: string;
  css: string;
  js: string;
  preview: boolean;
}): string {
  const { site, page, body, css, js, preview } = args;
  const title = page.seo?.title || site.seo?.title || page.name || site.name;
  const description = page.seo?.description || site.seo?.description || "";
  const ogImage = page.seo?.ogImage || site.seo?.ogImage || "";
  const noindex = preview || page.seo?.noindex;

  // Los pixels no se cargan en la vista previa: ensuciarian las metricas con
  // las visitas de quien esta editando.
  const pixels = preview ? "" : renderPixels(site.pixels ?? {});

  return `<!doctype html>
<html lang="${escapeHtml(site.defaultLanguage || "es")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ?? "")}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ""}
${noindex ? '<meta name="robots" content="noindex,nofollow">' : ""}
<meta property="og:title" content="${escapeHtml(title ?? "")}">
${description ? `<meta property="og:description" content="${escapeHtml(description)}">` : ""}
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ""}
${site.favicon ? `<link rel="icon" href="${escapeHtml(site.favicon)}">` : ""}
${css ? `<style>${css}</style>` : ""}
${pixels}
${site.headHtml ?? ""}
</head>
<body>
${body}
${site.bodyEndHtml ?? ""}
${js ? `<script>${js}</script>` : ""}
</body>
</html>`;
}

function renderPixels(p: Record<string, string>): string {
  const out: string[] = [];

  if (p.ga4MeasurementId) {
    out.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${p.ga4MeasurementId}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${p.ga4MeasurementId}');</script>`);
  }

  if (p.gtmContainerId) {
    out.push(`<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${p.gtmContainerId}');</script>`);
  }

  if (p.metaPixelId) {
    out.push(`<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${p.metaPixelId}');fbq('track','PageView');</script>`);
  }

  if (p.googleAdsConversionId) {
    out.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${p.googleAdsConversionId}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${p.googleAdsConversionId}');</script>`);
  }

  return out.join("\n");
}

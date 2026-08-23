import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";

import { NextRequest, type RouteHandler } from "./next-shim";

/** Headers hop-by-hop que no se reenvian al handler. */
const SKIP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

/** Headers que Node maneja solo al escribir la respuesta. */
const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

function buildRequest(req: Request): NextRequest {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ??
    req.protocol ??
    "http";
  const host = req.get("host") ?? "localhost";
  const url = new URL(req.originalUrl, `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  }

  return new NextRequest(url, { method: req.method, headers, body });
}

async function sendResponse(out: Response_, res: Response): Promise<void> {
  res.status(out.status);
  out.headers.forEach((value, key) => {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });

  if (!out.body) {
    res.end();
    return;
  }

  // flushHeaders permite que SSE empiece a emitir antes de cerrar el stream.
  res.flushHeaders?.();

  const nodeStream = Readable.fromWeb(out.body as never);
  nodeStream.on("error", () => res.destroy());
  res.on("close", () => nodeStream.destroy());
  nodeStream.pipe(res);
}

// Alias para no chocar con el `Response` de Express.
type Response_ = globalThis.Response;

/** Envuelve un route handler estilo Next como middleware de Express. */
export function adapt(handler: RouteHandler): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await handler(buildRequest(req));
      if (res.headersSent) return;
      await sendResponse(out, res);
    } catch (err) {
      next(err);
    }
  };
}

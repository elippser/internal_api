// Router del hub de eventos de negocios / MICE. Se monta en /api/global/mice
// (ver index.ts): mismo perimetro que los otros hubs, escrito a mano.

import { Router, type Request, type Response } from "express";
import { getMicePoint } from "./mice.service";

export const miceRouter = Router();

miceRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 150 : Number(req.query.radiusKm);
  const months = req.query.months === undefined ? 36 : Number(req.query.months);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 5000) {
    res.status(400).json({ error: "radiusKm fuera de rango (1-5000)" });
    return;
  }
  if (!Number.isFinite(months) || months <= 0 || months > 120) {
    res.status(400).json({ error: "months fuera de rango (1-120)" });
    return;
  }

  try {
    const payload = await getMicePoint(lat, lng, radiusKm, months);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[mice] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes MICE no disponibles",
    });
  }
});

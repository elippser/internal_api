// Router del hub de eventos culturales. Se monta en /api/global/culture (ver
// index.ts): mismo perimetro que los otros hubs de /global, escrito a mano y
// fuera del port de elippser-gl.

import { Router, type Request, type Response } from "express";
import { getCulturePoint } from "./culture.service";

export const cultureRouter = Router();

cultureRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  // Radio por defecto mas chico que el de deportes: la cola larga cultural es
  // urbana (un recital, una obra), no regional como unos Juegos Olimpicos.
  const radiusKm = req.query.radiusKm === undefined ? 150 : Number(req.query.radiusKm);
  const months = req.query.months === undefined ? 24 : Number(req.query.months);

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
    const payload = await getCulturePoint(lat, lng, radiusKm, months);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[culture] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes culturales no disponibles",
    });
  }
});

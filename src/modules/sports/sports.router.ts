// Router del hub de eventos deportivos. Se monta en /api/global/sports (ver
// index.ts): mismo perimetro que los hubs de clima y calendario, y escrito a
// mano — NO es parte del port de elippser-gl.

import { Router, type Request, type Response } from "express";
import { getSportsPoint } from "./sports.service";

export const sportsRouter = Router();

sportsRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 300 : Number(req.query.radiusKm);
  const months = req.query.months === undefined ? 60 : Number(req.query.months);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 5000) {
    res.status(400).json({ error: "radiusKm fuera de rango (1-5000)" });
    return;
  }
  if (!Number.isFinite(months) || months <= 0 || months > 180) {
    res.status(400).json({ error: "months fuera de rango (1-180)" });
    return;
  }

  try {
    const payload = await getSportsPoint(lat, lng, radiusKm, months);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[sports] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes deportivas no disponibles",
    });
  }
});

// Router del hub de ubicacion y entorno fisico. Se monta en /api/global/place.
// El radio es chico a proposito: esta categoria se mide caminando.

import { Router, type Request, type Response } from "express";
import { getPlacePoint } from "./place.service";

export const placeRouter = Router();

placeRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 1 : Number(req.query.radiusKm);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 5) {
    res.status(400).json({ error: "radiusKm fuera de rango (0-5)" });
    return;
  }

  try {
    const payload = await getPlacePoint(lat, lng, radiusKm);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[place] fetch failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Censo del entorno no disponible" });
  }
});

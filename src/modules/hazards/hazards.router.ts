// Router del hub de desastres naturales. Se monta en /api/global/hazards
// (ver index.ts): mismo perimetro que los otros hubs, escrito a mano.

import { Router, type Request, type Response } from "express";
import { getHazardsPoint } from "./hazards.service";

export const hazardsRouter = Router();

hazardsRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 500 : Number(req.query.radiusKm);
  const days = req.query.days === undefined ? 30 : Number(req.query.days);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 3000) {
    res.status(400).json({ error: "radiusKm fuera de rango (1-3000)" });
    return;
  }
  if (!Number.isFinite(days) || days < 1 || days > 90) {
    res.status(400).json({ error: "days fuera de rango (1-90)" });
    return;
  }

  try {
    const payload = await getHazardsPoint(lat, lng, radiusKm, days);
    // Ventana corta: una alerta vieja es peor que ninguna.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.json(payload);
  } catch (err) {
    console.error("[hazards] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes de amenazas no disponibles",
    });
  }
});

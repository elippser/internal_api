// Router del hub de conectividad y transporte. Se monta en
// /api/global/connectivity (ver index.ts): mismo perimetro que los otros hubs,
// escrito a mano.

import { Router, type Request, type Response } from "express";
import { getConnectivityPoint } from "./connectivity.service";

export const connectivityRouter = Router();

connectivityRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 100 : Number(req.query.radiusKm);

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
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 500) {
    res.status(400).json({ error: "radiusKm fuera de rango (1-500)" });
    return;
  }

  try {
    const payload = await getConnectivityPoint(lat, lng, radiusKm);
    // Cache corta: la mitad del payload es una observacion en vivo.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    res.json(payload);
  } catch (err) {
    console.error("[connectivity] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes de conectividad no disponibles",
    });
  }
});

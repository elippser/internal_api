// Router del hub de factores economicos y financieros. Se monta en
// /api/global/economy (ver index.ts): mismo perimetro que los otros hubs,
// escrito a mano.
//
// No toma radiusKm: la economia es del pais entero, no de un radio. El punto
// del mapa solo resuelve de que pais se trata.

import { Router, type Request, type Response } from "express";
import { getEconomyPoint } from "./economy.service";

export const economyRouter = Router();

economyRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

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

  try {
    const payload = await getEconomyPoint(lat, lng);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[economy] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes economicas no disponibles",
    });
  }
});

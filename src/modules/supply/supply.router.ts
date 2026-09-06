// Router del hub de oferta hotelera y competencia. Se monta en
// /api/global/supply (ver index.ts).

import { Router, type Request, type Response } from "express";
import { getSupplyPoint } from "./supply.service";

export const supplyRouter = Router();

supplyRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 5 : Number(req.query.radiusKm);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 30) {
    res.status(400).json({ error: "radiusKm fuera de rango (1-30)" });
    return;
  }

  try {
    const payload = await getSupplyPoint(lat, lng, radiusKm);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[supply] fetch failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Censo de oferta no disponible" });
  }
});

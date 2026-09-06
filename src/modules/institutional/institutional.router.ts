// Router del hub institucional. Se monta en /api/global/institutional.

import { Router, type Request, type Response } from "express";
import { getInstitutionalPoint } from "./institutional.service";

export const institutionalRouter = Router();

institutionalRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm === undefined ? 10 : Number(req.query.radiusKm);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 30) {
    res.status(400).json({ error: "radiusKm fuera de rango (1-30)" });
    return;
  }

  try {
    const payload = await getInstitutionalPoint(lat, lng, radiusKm);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[institutional] fetch failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Censo institucional no disponible" });
  }
});

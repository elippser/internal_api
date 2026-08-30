// Router del hub de estacionalidad climática. Se monta en /api/global/climate
// (ver index.ts): mismo perímetro sin auth que el resto de los feeds de la
// vista /global, y escrito a mano — NO es parte del port de elippser-gl.

import { Router, type Request, type Response } from "express";
import { getClimatePoint } from "./climate.service";

export const climateRouter = Router();

climateRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng inválidos" });
    return;
  }

  try {
    const payload = await getClimatePoint(lat, lng);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[climate] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes climáticas no disponibles",
    });
  }
});

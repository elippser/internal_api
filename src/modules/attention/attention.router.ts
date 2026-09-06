// Router del hub de atencion y tendencias. Se monta en /api/global/attention.

import { Router, type Request, type Response } from "express";
import { getAttentionPoint } from "./attention.service";

export const attentionRouter = Router();

attentionRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const days = req.query.days === undefined ? 180 : Number(req.query.days);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng invalidos" });
    return;
  }
  if (!Number.isFinite(days) || days < 30 || days > 720) {
    res.status(400).json({ error: "days fuera de rango (30-720)" });
    return;
  }

  try {
    const payload = await getAttentionPoint(lat, lng, days);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[attention] fetch failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Series de atencion no disponibles" });
  }
});

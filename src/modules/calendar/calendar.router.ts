// Router del hub de calendario y feriados. Se monta en /api/global/calendar
// (ver index.ts): mismo perímetro que el hub de clima y que el resto de los
// feeds de /global, y escrito a mano — NO es parte del port de elippser-gl.

import { Router, type Request, type Response } from "express";
import { getCalendarPoint } from "./calendar.service";

export const calendarRouter = Router();

calendarRouter.get("/point", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng inválidos" });
    return;
  }

  try {
    const payload = await getCalendarPoint(lat, lng);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[calendar] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes de calendario no disponibles",
    });
  }
});

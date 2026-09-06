// Router del hub de politicas migratorias y regulatorias. Se monta en
// /api/global/policy (ver index.ts): mismo perimetro que los otros hubs,
// escrito a mano.
//
// No toma radiusKm: la politica migratoria es del pais entero. La regulacion
// de alquiler temporario si es local, pero su alcance lo define cada norma en
// la tabla curada, no el usuario.

import { Router, type Request, type Response } from "express";
import { getPolicyPoint } from "./policy.service";

export const policyRouter = Router();

policyRouter.get("/point", async (req: Request, res: Response) => {
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
    const payload = await getPolicyPoint(lat, lng);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (err) {
    console.error("[policy] fetch failed:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Fuentes regulatorias no disponibles",
    });
  }
});

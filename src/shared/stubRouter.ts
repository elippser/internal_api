import { Router } from "express";

export function stubRouter(label: string): Router {
  const r = Router();
  r.all("*", (_req, res) => {
    res.status(501).json({
      error: `Modulo ${label} todavia no implementado`,
      code: "not_implemented",
    });
  });
  return r;
}

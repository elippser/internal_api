import type { Request, Response } from "express";
import mongoose from "mongoose";
import { getPmsConnection } from "../../shared/pmsDb";
import { ok } from "../../shared/utils/http";

interface CheckResult {
  name: string;
  url?: string;
  status: "ok" | "down" | "slow" | "skip";
  latencyMs: number | null;
  detail?: string;
}

const SERVICES = [
  { name: "pms-core", env: "PMS_CORE_API_URL" },
  { name: "booking-app", env: "BOOKING_API_URL" },
  { name: "rooms-app", env: "ROOMS_API_URL" },
] as const;

const TIMEOUT_MS = 3000;
const SLOW_MS = 800;

async function pingHttp(name: string, base: string): Promise<CheckResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${base.replace(/\/$/, "")}/health`;
    const res = await fetch(url, { signal: ctrl.signal });
    const latency = Date.now() - start;
    if (!res.ok) {
      return {
        name,
        url,
        status: "down",
        latencyMs: latency,
        detail: `HTTP ${res.status}`,
      };
    }
    return {
      name,
      url,
      status: latency > SLOW_MS ? "slow" : "ok",
      latencyMs: latency,
    };
  } catch (err) {
    return {
      name,
      url: base,
      status: "down",
      latencyMs: null,
      detail: err instanceof Error ? err.message : "fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pingMongoInternal(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("not connected");
    await db.admin().ping();
    return {
      name: "mongo-internal",
      status: "ok",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "mongo-internal",
      status: "down",
      latencyMs: null,
      detail: err instanceof Error ? err.message : "ping failed",
    };
  }
}

async function pingMongoPms(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const conn = await getPmsConnection();
    if (!conn.db) throw new Error("not connected");
    await conn.db.admin().ping();
    return {
      name: "mongo-pms",
      status: "ok",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "mongo-pms",
      status: "down",
      latencyMs: null,
      detail: err instanceof Error ? err.message : "ping failed",
    };
  }
}

export const systemController = {
  async health(_req: Request, res: Response) {
    const httpChecks = await Promise.all(
      SERVICES.map((s) => {
        const base = process.env[s.env];
        if (!base) {
          return Promise.resolve({
            name: s.name,
            status: "skip" as const,
            latencyMs: null,
            detail: `${s.env} no configurado`,
          });
        }
        return pingHttp(s.name, base);
      }),
    );

    const [internal, pms] = await Promise.all([
      pingMongoInternal(),
      pingMongoPms(),
    ]);

    return ok(res, {
      services: httpChecks,
      mongo: [internal, pms],
      uptime: Math.round(process.uptime()),
      nodeVersion: process.version,
      generatedAt: new Date().toISOString(),
    });
  },
};

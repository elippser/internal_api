import mongoose, { type Connection } from "mongoose";

let rmsConn: Connection | null = null;
/** Cachea la promesa, no sólo el resultado: si dos recolectores del rollup
 *  piden la conexión a la vez, ambos esperan el MISMO handshake en vez de
 *  abrir dos conexiones al cluster. */
let connecting: Promise<Connection> | null = null;

/**
 * Conexión secundaria de sólo lectura al cluster del RMS (DB `laupser_rms`).
 * Espejo de `pmsDb.ts`: `createConnection` para no pisar la conexión default
 * de internal-laupser.
 *
 * El RMS vive en una base distinta a la del PMS aunque compartan cluster, así
 * que NO se puede hacer `$lookup` entre `rms_daily_facts` y `reservations`:
 * el rollup diario lee de las dos por separado y cruza en memoria por
 * `propertyId`. Ver METRICAS-COMPORTAMIENTO-SPEC.md §3.1.
 */
export async function getRmsConnection(): Promise<Connection> {
  if (rmsConn && rmsConn.readyState === 1) return rmsConn;
  if (connecting) return connecting;

  const uri = process.env.RMS_MONGODB_URI;
  if (!uri) throw new Error("RMS_MONGODB_URI no esta configurado");

  connecting = (async () => {
    const conn = mongoose.createConnection(uri);
    await conn.asPromise();
    rmsConn = conn;
    console.log("[metrics] RMS DB connected");
    return conn;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

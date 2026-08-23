import mongoose, { type Connection } from "mongoose";

let pmsConn: Connection | null = null;
// Cachea la promesa, no sólo el resultado: sin esto, dos llamadas concurrentes
// (p. ej. los recolectores del rollup de métricas) abren cada una su propia
// conexion al cluster porque las dos ven readyState !== 1.
let connecting: Promise<Connection> | null = null;

// Conexion secundaria al cluster del PMS. Usamos createConnection en lugar
// de mongoose.connect para no pisar la conexion default de internal-laupser.
export async function getPmsConnection(): Promise<Connection> {
  if (pmsConn && pmsConn.readyState === 1) return pmsConn;
  if (connecting) return connecting;

  const uri = process.env.PMS_MONGODB_URI;
  if (!uri) throw new Error("PMS_MONGODB_URI no esta configurado");

  connecting = (async () => {
    const conn = mongoose.createConnection(uri);
    await conn.asPromise();
    pmsConn = conn;
    console.log("[hotels] PMS DB connected");
    return conn;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

import mongoose from "mongoose";

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI no esta definida en el entorno");
  }
  // Cluster M0: 500 conexiones para TODO el stack. Pool chico y las ociosas se
  // cierran solas (03-11-2026: al llegar al tope cayó el login del PMS).
  await mongoose.connect(uri, {
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 8_000,
  });
  console.log(`[internal] MongoDB connected → ${mongoose.connection.name}`);
}

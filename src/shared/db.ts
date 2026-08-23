import mongoose from "mongoose";

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI no esta definida en el entorno");
  }
  await mongoose.connect(uri);
  console.log(`[internal] MongoDB connected → ${mongoose.connection.name}`);
}

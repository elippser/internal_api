import jwt from "jsonwebtoken";

// Firma un JWT de usuario equivalente al que emite el PMS, para que los
// scripts puedan mandar X-Pms-User-Token en las rutas runtime de
// /conversations/sessions. Esas rutas ya no se conforman con el
// X-Internal-Secret (que solo prueba "viene del PMS"): exigen saber QUE
// usuario esta del otro lado para no dejar abrir la conversacion de otro.
// Usa el mismo secret que verifyUserToken.
export function devUserToken(userId: string): string {
  const secret = [
    process.env.SHARED_JWT_SECRET,
    process.env.JWT_SECRET,
    process.env.PMS_JWT_SECRET,
  ]
    .map((s) => s?.trim())
    .find((s): s is string => Boolean(s));
  if (!secret) {
    throw new Error(
      "Falta SHARED_JWT_SECRET/JWT_SECRET/PMS_JWT_SECRET para firmar el token de usuario del script",
    );
  }
  return jwt.sign({ userId }, secret, { expiresIn: "2h" });
}

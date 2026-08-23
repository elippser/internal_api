import "dotenv/config";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { makeId } from "../shared/utils/ids";
import { InternalUser } from "../modules/users/users.model";
import { INITIAL_TOOLS, Tool } from "../modules/tools/tools.model";

// Credenciales del super_admin inicial. Sobreescribibles por entorno para no
// tener que tocar el script cuando cambian (ver ADMIN_EMAIL/ADMIN_PASSWORD).
const SEED_EMAIL = process.env.ADMIN_EMAIL ?? "admin@bookfer.com";
const SEED_PASSWORD = process.env.ADMIN_PASSWORD ?? "ChangeMe123!";

async function seed() {
  await connectDB();

  const existingAdmin = await InternalUser.findOne({ role: "super_admin" });
  if (!existingAdmin) {
    await InternalUser.create({
      userId: makeId("iuser"),
      email: SEED_EMAIL,
      passwordHash: await bcrypt.hash(SEED_PASSWORD, 10),
      firstName: "Admin",
      lastName: "Laupser",
      role: "super_admin",
      status: "active",
    });
    console.log(`✓ Super admin creado: ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  } else {
    console.log("• Super admin ya existe, skip");
  }

  // 12 tools iniciales. requiredRoles y authStrategy vienen explicitos
  // del INITIAL_TOOLS — el seed solo aplica defaults de timeout y status.
  const toolCount = await Tool.countDocuments();
  if (toolCount === 0) {
    await Tool.insertMany(
      INITIAL_TOOLS.map((t) => ({
        ...t,
        status: (t as { status?: string }).status ?? "active",
        execution: {
          authStrategy: "staff_jwt",
          timeout: 10000,
          ...t.execution,
        },
      })),
    );
    console.log(`✓ ${INITIAL_TOOLS.length} tools iniciales insertadas`);
  } else {
    console.log(`• ${toolCount} tools ya existen, skip`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] error:", err);
  process.exit(1);
});

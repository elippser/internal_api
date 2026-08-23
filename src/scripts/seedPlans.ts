import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { makeId } from "../shared/utils/ids";
import { Plan } from "../modules/plans/plans.model";
import { productsService } from "../modules/plans/plans.service";

/**
 * Siembra el catalogo de productos del full system y tres planes de arranque.
 *
 *   npm run seed:plans
 *
 * Idempotente: los productos se siembran por `key` y los planes por `slug`, asi
 * que correrlo dos veces no duplica ni pisa lo que se haya editado a mano desde
 * el panel. Los planes nacen en `draft`: el equipo revisa precios y textos
 * antes de que aparezcan en la pantalla de eleccion del alta.
 */

interface SeedPlan {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  productKeys: string[];
  price: { amount: number; currency: string; period: "monthly" | "yearly" };
  free: boolean;
  freeDurationDays: number | null;
  trialDays: number;
  limits: {
    maxProperties: number | null;
    maxUsers: number | null;
    iaMonthlyCredits: number | null;
  };
  order: number;
  highlighted: boolean;
}

const PLAN_SEED: SeedPlan[] = [
  {
    slug: "inicial",
    name: "Inicial",
    tagline: "Para poner el alojamiento a operar y recibir reservas online",
    description:
      "El núcleo del PMS: habitaciones, reservas y el motor público. Gratuito por tiempo limitado para probar la plataforma con datos reales.",
    productKeys: ["habitaciones", "reservas", "motor"],
    price: { amount: 0, currency: "USD", period: "monthly" },
    free: true,
    // Todo plan gratuito vence: sin fecha de corte la cuenta se queda adentro
    // para siempre sin pagar.
    freeDurationDays: 30,
    trialDays: 0,
    limits: { maxProperties: 1, maxUsers: 3, iaMonthlyCredits: 0 },
    order: 10,
    highlighted: false,
  },
  {
    slug: "profesional",
    name: "Profesional",
    tagline: "El alojamiento completo: operación, marketing y presencia web",
    description:
      "Suma sitio web, identidad de marca, galerías, reseñas, LinkHub e informes al núcleo operativo. Es el plan que cubre a la mayoría de los alojamientos chicos y medianos.",
    productKeys: [
      "habitaciones",
      "reservas",
      "motor",
      "informes",
      "website",
      "marca",
      "galerias",
      "resenas",
      "linkhub",
      "archivos",
      "staypass",
    ],
    price: { amount: 79, currency: "USD", period: "monthly" },
    free: false,
    freeDurationDays: null,
    trialDays: 14,
    limits: { maxProperties: 3, maxUsers: 15, iaMonthlyCredits: 500000 },
    order: 20,
    highlighted: true,
  },
  {
    slug: "full-system",
    name: "Full System",
    tagline: "Todo bookfer, incluido revenue management y el asistente de IA",
    description:
      "Todos los productos de la plataforma: el núcleo operativo, marketing completo, Revenue (RMS), presencia online y Bookfer IA con créditos mensuales.",
    productKeys: [
      "habitaciones",
      "reservas",
      "motor",
      "informes",
      "revenue",
      "website",
      "marca",
      "galerias",
      "resenas",
      "linkhub",
      "social-hub",
      "archivos",
      "staypass",
      "bookfer-ia",
    ],
    price: { amount: 199, currency: "USD", period: "monthly" },
    free: false,
    freeDurationDays: null,
    trialDays: 14,
    limits: { maxProperties: null, maxUsers: null, iaMonthlyCredits: 3000000 },
    order: 30,
    highlighted: false,
  },
];

async function seed() {
  await connectDB();

  const products = await productsService.seed("seed");
  console.log(
    `✓ productos: ${products.created} creados, ${products.total} en total`,
  );

  let created = 0;
  for (const item of PLAN_SEED) {
    const exists = await Plan.findOne({ slug: item.slug }).lean();
    if (exists) {
      console.log(`• plan "${item.slug}" ya existe, skip`);
      continue;
    }
    await Plan.create({
      ...item,
      planId: makeId("plan"),
      // Draft a proposito: nadie deberia poder elegir un plan cuyo precio no
      // revisó todavia el equipo comercial.
      status: "draft",
      public: true,
      createdByUserId: "seed",
    });
    created += 1;
    console.log(`✓ plan "${item.slug}" creado (draft)`);
  }

  console.log(
    created > 0
      ? `\n${created} plan(es) creados en borrador. Activalos desde /plans en el panel.`
      : "\nSin planes nuevos.",
  );

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed:plans] error:", err);
  process.exit(1);
});

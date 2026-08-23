/**
 * Glosario de campos (spec v2 §3): la regla de carga inequivoca de cada campo.
 * Lo sirve GET /competitors/glossary (con overrides de settings.fieldHelp) y
 * lo usa el borrador IA para no confundir "integracion" con "nativo".
 */

export interface FieldHelp {
  path: string;
  label: string;
  definition: string; // que SI
  exclude: string; // que NO
  source: string; // fuente esperada
  example: string;
}

export const FIELD_GLOSSARY: FieldHelp[] = [
  {
    path: "name",
    label: "Nombre y aliases",
    definition:
      "Nombre comercial del PRODUCTO (no de la empresa, salvo que coincida). Aliases = otras formas de nombrarlo en ventas o en la web.",
    exclude: "Eslóganes; agregar 'PMS' si no se usa así.",
    source: "Home del producto.",
    example: "Kunas · aliases: Kunas PMS, kunas.io",
  },
  {
    path: "website",
    label: "Sitio y dominios extra",
    definition: "Home del producto; dominios secundarios de la misma marca (app, docs, empresa).",
    exclude: "Perfiles sociales, directorios.",
    source: "Home.",
    example: "cloudbeds.com + myfrontdesk.cloudbeds.com",
  },
  {
    path: "productTypes",
    label: "Qué vende",
    definition: "Tipos de producto del catálogo que efectivamente vende hoy.",
    exclude: "Lo que 'planea' o anuncia sin estar disponible.",
    source: "Home / página de features.",
    example: "Suite = PMS + motor + channel manager nativos.",
  },
  {
    path: "targetSizes",
    label: "Tamaño objetivo",
    definition: "Tamaño de alojamiento al que apunta: micro (1-10), small (11-50), mid (51-150), large (150+ / cadenas).",
    exclude: "Nuestro deseo de que sea chico.",
    source: "Pricing (rangos de habitaciones), casos de cliente.",
    example: "LobbyPMS: micro, small",
  },
  {
    path: "geoFocus",
    label: "Foco geográfico",
    definition: "Países ISO-2 donde vende activamente, o regiones (latam, global, europe).",
    exclude: "El idioma del sitio.",
    source: "Home, casos, moneda, facturación local.",
    example: "CO, DO, latam",
  },
  {
    path: "pricing.visibility",
    label: "Visibilidad de precio",
    definition: "public (precio publicado) · partial (sólo 'desde…') · quote_only (a cotizar) · freemium · unknown.",
    exclude: "—",
    source: "Pricing page.",
    example: "Cloudbeds: quote_only",
  },
  {
    path: "pricing.plans",
    label: "Planes",
    definition:
      "Cada plan publicado: nombre, precio MENSUAL (y anual prorrateado si lo hay), moneda, unidad (por habitación / por propiedad / fijo / comisión), rango de habitaciones que cubre, qué incluye.",
    exclude: "Promos temporales; precios 'desde' sin unidad.",
    source: "Pricing page (URL + fecha observada).",
    example: "Pro · USD 4 / habitación / mes · 1-30 hab.",
  },
  {
    path: "pricing.normalized",
    label: "Precio normalizado",
    definition: "Calculado por el sistema: costo mensual en USD para el hotel de referencia (settings).",
    exclude: "Se carga a mano.",
    source: "Cálculo desde los planes.",
    example: "15 hab × USD 4 = USD 60 / mes",
  },
  {
    path: "featureMatrix",
    label: "Matriz de features",
    definition:
      "Por feature del catálogo: native (incluida), addon (pago extra propio), integration (de un tercero), no, unknown. Con URL de evidencia.",
    exclude: "'Lo anuncian' sin estar disponible; suposiciones.",
    source: "Página de features / docs / demo.",
    example: "WhatsApp: integration (vía tercero)",
  },
  {
    path: "statedPositioning",
    label: "Posicionamiento declarado",
    definition: "Cita LITERAL de cómo se venden ellos (hero de la home).",
    exclude: "Nuestra interpretación.",
    source: "Home, con la cita.",
    example: "\"Not your average PMS…\"",
  },
  {
    path: "weaknesses",
    label: "Debilidades",
    definition: "Lo que un prospecto SUFRE hoy con ellos, por tema, con evidencia (review, foro, mención).",
    exclude: "Nuestra opinión, deseo o suposición.",
    source: "Reviews / foros / menciones (URL).",
    example: "price — 'precio no publicado, hay que pedir cotización' (G2)",
  },
  {
    path: "ourAngle",
    label: "Nuestro ángulo",
    definition: "La promesa concreta nuestra contra ese competidor, en una frase usable en una llamada.",
    exclude: "Una lista de features.",
    source: "Curación humana.",
    example: "Precio visible y onboarding solo en 10 minutos.",
  },
  {
    path: "mentions",
    label: "Menciones de prospectos",
    definition:
      "Un prospecto o cliente real lo nombró: fecha, contexto (demo, llamada, WhatsApp, email, evento, formulario), qué dijo, cuenta del CRM si existe.",
    exclude: "Que lo vimos nosotros en una nota o en una búsqueda.",
    source: "CRM / inbox.",
    example: "whatsapp — 'ya usa X y paga USD 90'",
  },
  {
    path: "priority",
    label: "Prioridad",
    definition:
      "A = ≥ 2 menciones en 90 días, o solapamiento ≥ 70 con tracción. B = solapamiento ≥ 40. C = el resto. La sugerida se calcula; la manual manda.",
    exclude: "Cambiarla por ansiedad.",
    source: "Sugerida + confirmación humana.",
    example: "—",
  },
  {
    path: "socialProfiles",
    label: "Perfiles sociales",
    definition: "Perfiles oficiales del producto/empresa por red, CONFIRMADOS por una persona.",
    exclude: "Perfiles de empleados, fan pages.",
    source: "Links de la home (descubiertos) / manual.",
    example: "instagram: @kunas.io",
  },
  {
    path: "watchedPages",
    label: "Páginas vigiladas",
    definition: "Páginas propias que anuncian cambios: pricing, features, blog, changelog, careers.",
    exclude: "Páginas de terceros.",
    source: "Links de la home / manual.",
    example: "/changelog",
  },
];

export function glossaryWithOverrides(overrides: Record<string, string> | null | undefined): FieldHelp[] {
  if (!overrides) return FIELD_GLOSSARY;
  return FIELD_GLOSSARY.map((f) =>
    typeof overrides[f.path] === "string" && overrides[f.path].trim()
      ? { ...f, definition: overrides[f.path].trim() }
      : f,
  );
}

/** Texto compacto para los prompts del borrador IA. */
export function glossaryForPrompt(): string {
  return FIELD_GLOSSARY.map((f) => `- ${f.path}: ${f.definition} NO: ${f.exclude}`).join("\n");
}

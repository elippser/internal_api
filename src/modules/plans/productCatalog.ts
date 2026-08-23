/**
 * Catalogo semilla de los productos del full system.
 *
 * Los productos viven en Mongo y se editan desde el panel: esto es solo el
 * punto de partida (`npm run seed:products`), no la fuente de verdad. Se
 * siembra por `key`, asi que correr la semilla dos veces no duplica nada ni
 * pisa lo que un operador haya editado a mano.
 *
 * `appIds` son ids reales del catalogo de apps del PMS
 * (`pms-core/api/src/constants/appCatalog.ts`): son los que traducen "este
 * plan incluye Revenue" a "este espacio puede abrir la app `revenue`".
 * `routes` son los prefijos de ruta del PMS que cubre el producto, y son los
 * que usa el gate del front cuando alguien entra por URL directa.
 *
 * `core: true` marca los productos que ningun plan puede dejar afuera (el
 * escritorio, los ajustes, las propiedades). Sin esto, un plan mal armado
 * dejaria a una cuenta sin poder ni entrar a configurar su empresa.
 */

export interface SeedProduct {
  key: string;
  name: string;
  description: string;
  category: string;
  appIds: string[];
  routes: string[];
  icon: string;
  core: boolean;
  order: number;
}

export const PRODUCT_CATEGORIES = [
  "core",
  "operacion",
  "comercial",
  "marketing",
  "ia",
  "huesped",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  core: "Base",
  operacion: "Operación",
  comercial: "Comercial",
  marketing: "Marketing",
  ia: "Inteligencia artificial",
  huesped: "Huésped",
};

export const PRODUCT_SEED: SeedProduct[] = [
  {
    key: "pms-core",
    name: "Escritorio PMS",
    description:
      "El escritorio de bookfer: navegación, contexto de empresa/propiedad/espacio, inicio y ajustes. Es la base sobre la que se monta el resto de los productos.",
    category: "core",
    appIds: [],
    routes: ["/", "/settings", "/profile", "/company", "/account", "/soporte"],
    icon: "LayoutDashboard",
    core: true,
    order: 10,
  },
  {
    key: "propiedades",
    name: "Propiedades y espacios",
    description:
      "Alta y ficha de las propiedades, espacios operativos y las apps que ve cada puesto de trabajo.",
    category: "core",
    appIds: ["propiedades"],
    routes: ["/properties"],
    icon: "Building2",
    core: true,
    order: 20,
  },
  {
    key: "habitaciones",
    name: "Habitaciones",
    description:
      "Inventario físico: categorías, unidades, estados operativos y plano de ocupación.",
    category: "operacion",
    appIds: ["estado-habitaciones", "plano-ocupacion", "gestion-categorias"],
    routes: ["/habitaciones"],
    icon: "BedDouble",
    core: false,
    order: 30,
  },
  {
    key: "reservas",
    name: "Reservas",
    description:
      "Operación comercial del día a día: panel del día, lista y calendario de reservas, carga manual, tarifas, disponibilidad y promociones.",
    category: "operacion",
    appIds: [
      "panel-reservas",
      "todas-reservas",
      "carga-manual",
      "tarifas",
      "disponibilidad",
      "promociones",
      "configuracion",
    ],
    routes: ["/reservas"],
    icon: "CalendarCheck",
    core: false,
    order: 40,
  },
  {
    key: "motor",
    name: "Motor de reservas",
    description:
      "El buscador y el checkout que ve el huésped, con su estudio de configuración. Superficie pública: no se abre desde el menú del PMS.",
    category: "comercial",
    appIds: [],
    routes: [],
    icon: "Globe",
    core: false,
    order: 50,
  },
  {
    key: "informes",
    name: "Informes",
    description:
      "Analítica operativa del alojamiento: ocupación, ingresos, producción por canal y cierres.",
    category: "comercial",
    appIds: ["informes"],
    routes: ["/informes"],
    icon: "BarChart3",
    core: false,
    order: 60,
  },
  {
    key: "revenue",
    name: "Revenue (RMS)",
    description:
      "Revenue management: pace, compset, eventos de demanda, reglas y recomendaciones de tarifa.",
    category: "comercial",
    appIds: ["revenue"],
    routes: ["/revenue"],
    icon: "TrendingUp",
    core: false,
    order: 70,
  },
  {
    key: "website",
    name: "Sitios web",
    description:
      "Constructor de sitios y el renderer que los publica: multi-idioma, dominio propio, SEO y GEO.",
    category: "marketing",
    appIds: ["sitios", "builder"],
    routes: ["/projects", "/sites", "/apps/builder"],
    icon: "Globe2",
    core: false,
    order: 80,
  },
  {
    key: "marca",
    name: "Identidad de marca",
    description:
      "Logo, paleta, tono, narrativa y contacto público de la propiedad. Alimenta el sitio, el motor y el LinkHub.",
    category: "marketing",
    appIds: ["marca"],
    routes: ["/brand"],
    icon: "Palette",
    core: false,
    order: 90,
  },
  {
    key: "galerias",
    name: "Galerías",
    description: "Galerías multimedia de la propiedad y sus habitaciones.",
    category: "marketing",
    appIds: ["galerias"],
    routes: ["/galleries"],
    icon: "Images",
    core: false,
    order: 100,
  },
  {
    key: "resenas",
    name: "Reseñas",
    description:
      "Reseñas de huéspedes, respuestas públicas y su reflejo en el sitio y en el motor.",
    category: "marketing",
    appIds: ["resenas"],
    routes: ["/reviews"],
    icon: "Star",
    core: false,
    order: 110,
  },
  {
    key: "linkhub",
    name: "LinkHub",
    description:
      "Página link-in-bio del alojamiento para redes sociales, con su renderer público.",
    category: "marketing",
    appIds: ["linkhub"],
    routes: ["/linkhub"],
    icon: "Link2",
    core: false,
    order: 120,
  },
  {
    key: "social-hub",
    name: "Presencia online",
    description:
      "Redes, Google Business Profile, fichas de OTA y control de SEO/GEO. Hoy oculta del menú del PMS.",
    category: "marketing",
    appIds: ["social-hub"],
    routes: ["/social-hub"],
    icon: "Megaphone",
    core: false,
    order: 130,
  },
  {
    key: "archivos",
    name: "Librería de archivos",
    description:
      "Almacenamiento compartido de imágenes y documentos del alojamiento.",
    category: "marketing",
    appIds: ["libreria-archivos"],
    routes: ["/files"],
    icon: "FolderOpen",
    core: false,
    order: 140,
  },
  {
    key: "staypass",
    name: "StayPass",
    description:
      "Portal del huésped: cuenta, reservas y perfil. Superficie pública, no se abre desde el PMS.",
    category: "huesped",
    appIds: [],
    routes: [],
    icon: "IdCard",
    core: false,
    order: 150,
  },
  {
    key: "bookfer-ia",
    name: "Bookfer IA",
    description:
      "El asistente conversacional del PMS: consulta y opera el sistema con herramientas. Consume créditos del contrato de IA.",
    category: "ia",
    appIds: [],
    routes: ["/bookfer-ia"],
    icon: "Sparkles",
    core: false,
    order: 160,
  },
];

/**
 * Catalogo de tecnologias del stack.
 *
 * Es la respuesta a "con que esta hecho esto", escrita a mano y cruzada contra
 * los `package.json`, los `Dockerfile` y los `.env` reales de cada repo. NO se
 * lee de npm ni de ningun registro: el panel no instala nada y no queremos que
 * una pantalla de lectura dependa de una API externa.
 *
 * La diferencia con `infra.inventory.ts` es la pregunta que responde cada uno:
 *
 *   infra.inventory  -> QUE corre, DONDE y con que deploy   (estado, sale de la red)
 *   architecture.*   -> COMO esta hecho y COMO se conecta   (analisis, sale del codigo)
 *
 * Cuando actualices una dependencia importante, actualiza `version` aca. El
 * campo `versionNote` existe justamente porque el stack NO esta parejo: hay
 * cuatro mayores de Next y dos de React conviviendo, y esconderlo detras de un
 * "Next.js" a secas seria mentir sobre el estado real de la plataforma.
 */

export type TechCategory =
  | "lenguaje"
  | "frontend"
  | "backend"
  | "datos"
  | "hosting"
  | "ia"
  | "externo";

export const TECH_CATEGORIES: {
  id: TechCategory;
  label: string;
  blurb: string;
}[] = [
  {
    id: "lenguaje",
    label: "Lenguajes y runtime",
    blurb: "Con que se escribe y sobre que corre.",
  },
  {
    id: "frontend",
    label: "Frontend",
    blurb: "Lo que se ejecuta en el navegador del hotelero y del huesped.",
  },
  {
    id: "backend",
    label: "Backend",
    blurb: "Las seis APIs y lo que comparten.",
  },
  {
    id: "datos",
    label: "Datos",
    blurb: "Donde vive el estado de la plataforma.",
  },
  {
    id: "hosting",
    label: "Hosting y entrega",
    blurb: "Quien ejecuta el codigo y quien resuelve los dominios.",
  },
  {
    id: "ia",
    label: "Inteligencia artificial",
    blurb: "Los modelos que consume el motor agentico.",
  },
  {
    id: "externo",
    label: "Servicios externos",
    blurb: "Terceros con los que la plataforma tiene cuenta y clave.",
  },
];

export interface Tech {
  /** Id estable del panel. */
  id: string;
  name: string;
  /**
   * Slug del logo en el bundle del frontend (simple-icons, CC0).
   * `null` = no hay marca disponible y la UI dibuja un monograma.
   */
  logo: string | null;
  category: TechCategory;
  /** Version tal como esta declarada en el repo. `null` = es un servicio SaaS. */
  version: string | null;
  /** Cuando la version NO es la misma en todos los repos. */
  versionNote?: string;
  /** Que hace, en una linea. */
  role: string;
  /** Ids de INFRA_SERVICES donde corre. Vacio = transversal a todo el stack. */
  services: string[];
  /** Que se rompe si esto se cae, sube de precio o cambia de licencia. */
  impact?: string;
  /** De donde sale el dato: el archivo que lo declara. */
  evidence: string;
  docs: string;
}

export const TECHNOLOGIES: Tech[] = [
  // --- Lenguajes y runtime -------------------------------------------------
  {
    id: "typescript",
    name: "TypeScript",
    logo: "typescript",
    category: "lenguaje",
    version: "5.5 - 5.6",
    role: "El lenguaje de todo el stack salvo el servicio de tendencias.",
    services: [],
    evidence: "devDependencies de las 6 APIs y de los 10 frontends",
    docs: "https://www.typescriptlang.org/docs/",
  },
  {
    id: "node",
    name: "Node.js",
    logo: "nodedotjs",
    category: "lenguaje",
    version: ">= 18",
    role: "Runtime de las seis APIs Express y de los nueve Next.js.",
    services: [],
    impact:
      "Es el piso de todo: 16 de los 17 deploys son procesos Node. El unico que no lo es corre Python.",
    evidence: "engines del package.json raiz",
    docs: "https://nodejs.org/docs/latest-v20.x/api/",
  },
  {
    id: "python",
    name: "Python",
    logo: "python",
    category: "lenguaje",
    version: "3.12-slim",
    role: "El unico servicio que no es Node: el scraper de Google Trends.",
    services: ["trends-service"],
    impact:
      "Aislado a proposito. Si se cae, el radar de demanda pierde una senal; no toca el PMS.",
    evidence: "internal-laupser/trends-service/Dockerfile",
    docs: "https://docs.python.org/3.12/",
  },

  // --- Frontend ------------------------------------------------------------
  {
    id: "react",
    name: "React",
    logo: "react",
    category: "frontend",
    version: "19.2.4",
    versionNote:
      "19.2.4 en las apps Next nuevas, ^19.0.0 en PMS / Habitaciones / StayPass, ^18.3.1 en este panel y en Revenue. Conviven dos mayores.",
    role: "La libreria de vista de las diez interfaces del stack.",
    services: [],
    evidence: "dependencies de cada frontend",
    docs: "https://react.dev/reference/react",
  },
  {
    id: "nextjs",
    name: "Next.js",
    logo: "nextdotjs",
    category: "frontend",
    version: "16.2.x",
    versionNote:
      "16.2.x en Reservas / Motor / sitios de hoteles / LinkHub / sitio de Roombir, 15.x en PMS / Habitaciones / StayPass, ~14.2 en Revenue. Cuatro mayores distintas.",
    role: "El framework de las nueve apps con render de servidor.",
    services: [
      "pms-app",
      "booking-web",
      "booking-engine",
      "rooms-web",
      "rms-web",
      "staypass-web",
      "mkt-renderer",
      "linkhub-renderer",
      "web-renderer",
    ],
    impact:
      "El salto de 14 a 16 no es cosmetico: Revenue quedo en 14.2 y por eso arrastro el bug del assetPrefix que dejaba la app sin hidratar.",
    evidence: "dependencies de los 9 frontends Next",
    docs: "https://nextjs.org/docs",
  },
  {
    id: "vite",
    name: "Vite",
    logo: "vite",
    category: "frontend",
    version: "^5.4",
    role: "El build de este panel. Es la unica interfaz que NO usa Next.",
    services: ["internal-web"],
    impact:
      "SPA pura: no hay render de servidor ni SEO que cuidar, y por eso el panel puede ser una sola bolsa de JS con rutas lazy.",
    evidence: "internal-laupser/web/package.json",
    docs: "https://vite.dev/guide/",
  },
  {
    id: "tailwind",
    name: "Tailwind CSS",
    logo: "tailwindcss",
    category: "frontend",
    version: "^4.0",
    role: "Los estilos de este panel, via el plugin de Vite.",
    services: ["internal-web"],
    impact:
      "Solo aca. El PMS y los renderers usan CSS Modules y tokens propios: no hay un sistema de estilos unico en la plataforma.",
    evidence: "@tailwindcss/vite en internal-laupser/web",
    docs: "https://tailwindcss.com/docs",
  },
  {
    id: "tanstack-query",
    name: "TanStack Query",
    logo: "reactquery",
    category: "frontend",
    version: "^5",
    role: "Cache y estado de servidor en el cliente.",
    services: ["internal-web", "pms-app", "rms-web"],
    evidence: "@tanstack/react-query en los tres frontends",
    docs: "https://tanstack.com/query/latest/docs/framework/react/overview",
  },
  {
    id: "react-router",
    name: "React Router",
    logo: "reactrouter",
    category: "frontend",
    version: "^6.26",
    role: "El ruteo del panel. Las apps Next usan su propio router de archivos.",
    services: ["internal-web"],
    evidence: "internal-laupser/web/src/router.tsx",
    docs: "https://reactrouter.com/en/main",
  },
  {
    id: "zod",
    name: "Zod",
    logo: "zod",
    category: "frontend",
    version: "^3.23",
    role: "Validacion de formularios del panel, junto a react-hook-form.",
    services: ["internal-web"],
    impact:
      "En el backend la validacion NO es Zod sino Joi. Son dos vocabularios distintos para el mismo contrato.",
    evidence: "internal-laupser/web/package.json",
    docs: "https://zod.dev/",
  },
  {
    id: "framer-motion",
    name: "Framer Motion",
    logo: "framer",
    category: "frontend",
    version: "^12",
    role: "Animaciones de la vista global.",
    services: ["internal-web"],
    evidence: "internal-laupser/web/package.json",
    docs: "https://motion.dev/docs",
  },
  {
    id: "maplibre",
    name: "MapLibre GL",
    logo: "maplibre",
    category: "frontend",
    version: "^5.24",
    role: "Los mapas de /global y del mapa de accesos.",
    services: ["internal-web"],
    impact:
      "Pesa lo suficiente como para que las dos pantallas que lo usan vayan lazy.",
    evidence: "maplibre-gl + react-map-gl en internal-laupser/web",
    docs: "https://maplibre.org/maplibre-gl-js/docs/",
  },
  {
    id: "lucide",
    name: "Lucide",
    logo: "lucide",
    category: "frontend",
    version: "^1.28",
    role: "La iconografia de este panel.",
    services: ["internal-web"],
    evidence: "lucide-react en internal-laupser/web",
    docs: "https://lucide.dev/guide/",
  },

  // --- Backend -------------------------------------------------------------
  {
    id: "express",
    name: "Express",
    logo: "express",
    category: "backend",
    version: "^4.18 - 4.21",
    role: "El framework HTTP de las seis APIs. Ninguna migro a 5.",
    services: [
      "pms-api",
      "booking-api",
      "rooms-api",
      "rms-api",
      "staypass-api",
      "internal-api",
    ],
    impact:
      "Todas comparten la misma forma: router por modulo, authenticate + authorize como middleware, Joi para validar.",
    evidence: "dependencies de las 6 APIs",
    docs: "https://expressjs.com/en/4x/api.html",
  },
  {
    id: "mongoose",
    name: "Mongoose",
    logo: "mongoose",
    category: "backend",
    version: "^8",
    role: "El ODM contra Mongo. No hay acceso crudo al driver salvo pings.",
    services: [
      "pms-api",
      "booking-api",
      "rooms-api",
      "rms-api",
      "staypass-api",
      "internal-api",
    ],
    impact:
      "El panel interno abre DOS conexiones: la suya y una secundaria de solo lectura contra la base del PMS.",
    evidence: "dependencies de las 6 APIs, internal shared/pmsDb.ts",
    docs: "https://mongoosejs.com/docs/guide.html",
  },
  {
    id: "jwt",
    name: "JSON Web Tokens",
    logo: "jsonwebtokens",
    category: "backend",
    version: "^9.0.2",
    role: "La moneda de identidad de todo el stack: staff, huesped y agente.",
    services: [],
    impact:
      "Conviven cinco familias de secreto (STAFF/JWT, SHARED, AGENT, GUEST y el propio del panel). Un secreto mal copiado no rompe el build: da 401 en produccion.",
    evidence: "jsonwebtoken en las 6 APIs, *_JWT_SECRET en los .env",
    docs: "https://github.com/auth0/node-jsonwebtoken#readme",
  },
  {
    id: "socketio",
    name: "Socket.IO",
    logo: "socketdotio",
    category: "backend",
    version: "^4.7",
    role: "Websockets de habitaciones y del portal del huesped.",
    services: ["rooms-api", "staypass-api", "pms-api"],
    impact:
      "Convive con Pusher haciendo casi lo mismo. Son dos caminos de tiempo real para la misma plataforma.",
    evidence: "socket.io en rooms-app/api, staypass-app/api y pms-core/api",
    docs: "https://socket.io/docs/v4/",
  },
  {
    id: "pusher",
    name: "Pusher",
    logo: "pusher",
    category: "backend",
    version: "^5.3 servidor, ^8.5 cliente",
    role: "El bus de notificaciones del PMS.",
    services: ["pms-api", "pms-app"],
    impact:
      "Es SaaS con cuota: a diferencia de Socket.IO, esto se paga por mensaje.",
    evidence: "pms-core/api/src/services/pusherBus.ts, pusher-js en pms-core/app",
    docs: "https://pusher.com/docs/channels/",
  },
  {
    id: "fastapi",
    name: "FastAPI",
    logo: "fastapi",
    category: "backend",
    version: ">= 0.115",
    role: "El framework del servicio de tendencias, servido con uvicorn.",
    services: ["trends-service"],
    evidence: "internal-laupser/trends-service/requirements.txt",
    docs: "https://fastapi.tiangolo.com/",
  },

  // --- Datos ---------------------------------------------------------------
  {
    id: "mongodb",
    name: "MongoDB Atlas",
    logo: "mongodb",
    category: "datos",
    version: null,
    role: "La unica base de datos de la plataforma. Un cluster, tres bases.",
    services: [],
    impact:
      "El cluster esta en Sao Paulo. Cuando las funciones de Vercel corrian en Virginia, ese salto era la causa de la lentitud de produccion.",
    evidence: "MONGODB_URI / DATABASE_MDB de los 6 .env.production",
    docs: "https://www.mongodb.com/docs/atlas/",
  },

  // --- Hosting y entrega ---------------------------------------------------
  {
    id: "vercel",
    name: "Vercel",
    logo: "vercel",
    category: "hosting",
    version: null,
    role: "Ejecuta 14 de los 17 deploys, cada uno desde su propio repo.",
    services: [],
    impact:
      "Cuenta Hobby: el presupuesto de llamadas y de builds es finito, y por eso el tablero de Infraestructura refresca con un boton y no solo.",
    evidence: "provider: vercel en infra.inventory.ts",
    docs: "https://vercel.com/docs",
  },
  {
    id: "coolify",
    name: "Coolify",
    logo: null,
    category: "hosting",
    version: null,
    role: "El PaaS propio del VPS. Corre los tres deploys que Vercel no puede.",
    services: ["web-renderer", "mkt-renderer", "trends-service"],
    impact:
      "Es el unico lugar del stack donde el servidor es nuestro: si el VPS se cae, no hay quien lo levante solo.",
    evidence: "provider: coolify en infra.inventory.ts",
    docs: "https://coolify.io/docs/",
  },
  {
    id: "docker",
    name: "Docker",
    logo: "docker",
    category: "hosting",
    version: null,
    role: "El empaquetado de lo que corre en el VPS.",
    services: ["web-renderer", "trends-service"],
    impact:
      "El sitio de Roombir es la excepcion: va con nixpacks, no con Dockerfile propio.",
    evidence: "Dockerfile de trends-service, stack de web-renderer",
    docs: "https://docs.docker.com/",
  },
  {
    id: "traefik",
    name: "Traefik",
    logo: "traefikproxy",
    category: "hosting",
    version: null,
    role:
      "El proxy del VPS: resuelve que dominio va a que contenedor y emite los certificados.",
    services: ["web-renderer", "mkt-renderer"],
    impact:
      "Para los sitios de hoteles le PREGUNTA al renderer que dominios servir (provider @http). El FQDN queda horneado en los labels del contenedor: cambiarlo son dos pasos, no uno.",
    evidence: "notas de web-renderer en infra.inventory.ts y dns.inventory.ts",
    docs: "https://doc.traefik.io/traefik/",
  },
  {
    id: "letsencrypt",
    name: "Let's Encrypt",
    logo: "letsencrypt",
    category: "hosting",
    version: null,
    role: "Los certificados del VPS, emitidos por Traefik via ACME.",
    services: ["web-renderer", "mkt-renderer"],
    impact:
      "El wildcard *.sites.roombir.com se emite por DNS-01 y solo funciona con el registro en GRIS. En naranja, cualquier preview da error de certificado.",
    evidence: "dns.inventory.ts, registro *.sites",
    docs: "https://letsencrypt.org/docs/",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    logo: "cloudflare",
    category: "hosting",
    version: null,
    role: "El DNS de roombir.com y el edge de los hostnames en naranja.",
    services: [],
    impact:
      "El alcance real es DNS y nada mas: el token ve cuatro zonas pero el panel administra UNA. No hay WAF ni Workers en juego.",
    evidence: "modulo dns/, CLOUDFLARE_API_TOKEN",
    docs: "https://developers.cloudflare.com/dns/",
  },
  {
    id: "github",
    name: "GitHub",
    logo: "github",
    category: "hosting",
    version: null,
    role: "El origen de todos los deploys. 17 repos sueltos, no un monorepo.",
    services: [],
    impact:
      "Los nombres no siguen una sola convencion y varios servicios todavia no tienen remoto: esos se suben a mano.",
    evidence: "githubRepo en infra.inventory.ts",
    docs: "https://docs.github.com/en/rest",
  },

  // --- Inteligencia artificial ---------------------------------------------
  {
    id: "anthropic",
    name: "Anthropic Claude",
    logo: "anthropic",
    category: "ia",
    version: "SDK ^0.95.2 y ^0.27.3",
    versionNote:
      "pms-core/api va en ^0.95.2 y el panel interno en ^0.27.3. Es la brecha de version mas grande del stack.",
    role: "El modelo que razona en Roombir IA y en el cron de tickets.",
    services: ["internal-api", "pms-api"],
    impact:
      "Es la unica dependencia de IA que factura por token en el camino caliente del producto. El cupo se controla en el plan de cada cuenta.",
    evidence: "@anthropic-ai/sdk en internal-laupser/api y pms-core/api",
    docs: "https://docs.claude.com/en/api/overview",
  },
  {
    id: "openai",
    name: "OpenAI",
    logo: "openai",
    category: "ia",
    version: "sin SDK",
    role: "Solo embeddings para RAG: text-embedding-3-small, por fetch crudo.",
    services: ["internal-api"],
    impact:
      "Si falta la clave, el embedder cae a un hash determinista de 384 dimensiones. El RAG sigue respondiendo, pero recupera peor.",
    evidence: "internal-laupser/api/src/shared/rag/embedder.ts",
    docs: "https://platform.openai.com/docs/guides/embeddings",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    logo: null,
    category: "ia",
    version: "sin SDK",
    role:
      "Router de modelos del motor agentico: permite elegir proveedor por agente.",
    services: ["internal-api", "pms-api"],
    evidence: "internal-laupser/api/src/engine/llm/providers/openrouter.ts",
    docs: "https://openrouter.ai/docs",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    logo: "googlegemini",
    category: "ia",
    version: "^0.24.1",
    role: "Modelo alternativo del motor y de las herramientas de inteligencia.",
    services: ["internal-api"],
    evidence: "@google/generative-ai en internal-laupser/api",
    docs: "https://ai.google.dev/gemini-api/docs",
  },

  // --- Servicios externos --------------------------------------------------
  {
    id: "auth0",
    name: "Auth0",
    logo: "auth0",
    category: "externo",
    version: "sin SDK",
    role:
      "El login federado del PMS. El intercambio lo hace el servidor, no el navegador.",
    services: ["pms-api", "pms-app"],
    impact:
      "El tenant sigue siendo el de desarrollo. Y como el intercambio es server-side, la IP real del usuario no llega sola: hay que puentearla con FRONT_PROXY_SECRET o la bitacora de accesos registra la del servidor.",
    evidence: "pms-core/api/src/services/auth0Service.ts y rutas /api/auth/auth0/*",
    docs: "https://auth0.com/docs",
  },
  {
    id: "resend",
    name: "Resend",
    logo: "resend",
    category: "externo",
    version: "^6",
    role: "Todo el correo saliente de la plataforma sale de aca.",
    services: ["pms-api", "booking-api", "staypass-api"],
    impact:
      "El hotel no pone su SMTP: los mails salen de un remitente propio y el hotel entra como Reply-To. Si Resend se cae, el huesped no recibe su confirmacion.",
    evidence: "resend en pms-core/api, booking-app/api y staypass-app/api",
    docs: "https://resend.com/docs",
  },
  {
    id: "cloudinary",
    name: "Cloudinary",
    logo: "cloudinary",
    category: "externo",
    version: "^2",
    role: "Las imagenes de la biblioteca de medios y de los sitios de hoteles.",
    services: ["pms-api", "rooms-api"],
    impact:
      "El upload preset viaja al navegador (NEXT_PUBLIC_*). Es publico a proposito, pero significa que la cuota se puede gastar desde afuera.",
    evidence: "cloudinary en pms-core/api y rooms-app/api",
    docs: "https://cloudinary.com/documentation",
  },
  {
    id: "maxmind",
    name: "MaxMind GeoIP",
    logo: null,
    category: "externo",
    version: "^5.0.7",
    role: "Geolocaliza las IPs de la bitacora de accesos, con IPinfo de respaldo.",
    services: ["pms-api"],
    impact:
      "Es lo que hace posible el bloqueo por pais. Base local en disco: si el archivo no esta, el enriquecimiento queda vacio y nada avisa.",
    evidence: "maxmind + GEOIP_CITY_DB_PATH en pms-core/api",
    docs: "https://dev.maxmind.com/geoip/",
  },
  {
    id: "google-translate",
    name: "Google Translate",
    logo: "googletranslate",
    category: "externo",
    version: "^9",
    role: "Traduccion de contenido de sitios y fichas.",
    services: ["pms-api"],
    evidence: "@google-cloud/translate en pms-core/api",
    docs: "https://cloud.google.com/translate/docs",
  },
  {
    id: "deepl",
    name: "DeepL",
    logo: "deepl",
    category: "externo",
    version: "^1.2",
    role: "Segundo traductor del PMS, en paralelo a Google.",
    services: ["pms-api"],
    evidence: "deepl-translator en pms-core/api",
    docs: "https://developers.deepl.com/docs",
  },
  {
    id: "ticketmaster",
    name: "Ticketmaster",
    logo: "ticketmaster",
    category: "externo",
    version: null,
    role: "Eventos con entrada para el radar de demanda y los hubs de /global.",
    services: ["internal-api", "rms-api"],
    evidence: "TICKETMASTER_API_KEY en internal-laupser/api y rms-app/api",
    docs: "https://developer.ticketmaster.com/",
  },
  {
    id: "eventbrite",
    name: "Eventbrite",
    logo: "eventbrite",
    category: "externo",
    version: null,
    role: "Eventos de cola larga para los hubs de cultura y MICE.",
    services: ["internal-api"],
    evidence: "EVENTBRITE_TOKEN en internal-laupser/api",
    docs: "https://www.eventbrite.com/platform/api",
  },
  {
    id: "openstreetmap",
    name: "OpenStreetMap",
    logo: "openstreetmap",
    category: "externo",
    version: null,
    role: "Overpass alimenta los hubs de oferta hotelera y entorno fisico.",
    services: ["internal-api"],
    impact:
      "El espejo overpass.osm.ch solo tiene datos de Suiza: contesta 200 vacio para el resto del mundo y gana el failover en silencio.",
    evidence: "conectores del intelligence-hub en internal-laupser/api",
    docs: "https://wiki.openstreetmap.org/wiki/Overpass_API",
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    logo: "wikipedia",
    category: "externo",
    version: null,
    role: "Las vistas de pagina son el proxy de atencion del hub de tendencias.",
    services: ["internal-api"],
    impact:
      "Cada idioma necesita SU titulo de articulo. Con el titulo equivocado la lectura se invierte sin dar error.",
    evidence: "conector de attention en internal-laupser/api",
    docs: "https://wikimedia.org/api/rest_v1/",
  },
];

export const TECH_BY_ID = new Map(TECHNOLOGIES.map((t) => [t.id, t]));

/** Las tecnologias que declaran correr en un servicio dado. */
export function techForService(serviceId: string): Tech[] {
  return TECHNOLOGIES.filter((t) => t.services.includes(serviceId));
}

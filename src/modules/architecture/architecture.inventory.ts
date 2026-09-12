/**
 * El mapa de la plataforma, de punta a punta.
 *
 * Cuatro tablas escritas a mano, cada una respondiendo una pregunta distinta:
 *
 *   LAYERS    en que capa vive cada cosa (de quien la mira hacia adentro)
 *   TOPOLOGY  para cada servicio: con que corre, contra que base, quien le
 *             pega y a quien le pega
 *   DATASTORES  donde vive el estado y quien lo escribe
 *   CHANNELS  los cables entre servicios: que secreto los abre y que llevan
 *   FLOWS     los recorridos completos, los que cruzan cuatro repos
 *
 * Todo sale de leer el codigo: los `.env.*` de cada repo, los routers montados
 * y los clientes HTTP. No hay nada inferido; cuando algo es una decision de
 * diseno y no un hecho medible, esta escrito en `gotcha` o en la nota del paso.
 *
 * El `id` de cada servicio es el MISMO de `infra.inventory.ts` a proposito: asi
 * el analisis y el estado hablan del mismo objeto y el panel puede enlazar de
 * una pantalla a la otra sin traducir nada.
 */

import { INFRA_SERVICES } from "../infra/infra.inventory";

// ---------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------

export type LayerId =
  | "cliente"
  | "borde"
  | "interfaz"
  | "api"
  | "datos"
  | "terceros";

export interface Layer {
  id: LayerId;
  label: string;
  /** Que vive en esta capa, en una linea. */
  blurb: string;
}

/** El orden es el del recorrido de una request: de afuera hacia adentro. */
export const LAYERS: Layer[] = [
  {
    id: "cliente",
    label: "Quien mira",
    blurb:
      "El huesped, el staff del hotel y el equipo interno. Tres publicos con tres puertas distintas.",
  },
  {
    id: "borde",
    label: "Borde",
    blurb:
      "Cloudflare resuelve el nombre; Vercel o Traefik deciden que proceso atiende.",
  },
  {
    id: "interfaz",
    label: "Interfaces",
    blurb:
      "Diez frontends. Nueve son Next.js; el unico que no lo es, este panel, es una SPA de Vite.",
  },
  {
    id: "api",
    label: "APIs y servicios",
    blurb:
      "Seis APIs Express mas el scraper de tendencias en Python. Ninguna habla con el navegador sin un JWT.",
  },
  {
    id: "datos",
    label: "Datos",
    blurb: "Un cluster de MongoDB Atlas en Sao Paulo, con tres bases.",
  },
  {
    id: "terceros",
    label: "Terceros",
    blurb:
      "Lo que no corre en nuestra infraestructura pero sin lo cual el producto no funciona.",
  },
];

// ---------------------------------------------------------------------------
// Topologia por servicio
// ---------------------------------------------------------------------------

/**
 * Los tres publicos de la plataforma.
 *
 * La capa "cliente" no tiene procesos nuestros -es gente con un navegador-,
 * pero dejarla vacia en el mapa haria que el sistema pareciera empezar en las
 * interfaces. Empieza antes: en tres publicos que entran por tres puertas
 * distintas y que no comparten ni identidad ni dominio.
 */
export const AUDIENCES: { id: string; label: string; sub: string }[] = [
  {
    id: "huesped",
    label: "Huesped",
    sub: "Motor de reservas, sitio del hotel y StayPass. JWT propio de huesped.",
  },
  {
    id: "staff",
    label: "Staff del hotel",
    sub: "El PMS y las tres apps embebidas. JWT de staff con rol y capabilities.",
  },
  {
    id: "interno",
    label: "Equipo de Roombir",
    sub: "Este panel. JWT propio, que ninguna API del producto acepta.",
  },
];

export interface ServiceTopology {
  /** Mismo id que en infra.inventory.ts. */
  id: string;
  layer: LayerId;
  /** Puerto en el `npm run dev` de la raiz. `null` = no se levanta en local. */
  localPort: number | null;
  /** basePath cuando la app se sirve embebida dentro del PMS. */
  basePath?: string;
  /** Ids de TECHNOLOGIES que definen el runtime. */
  techIds: string[];
  /** Id de DATASTORES. `null` = no toca la base. */
  datastore: string | null;
  /** Quien le pega a este servicio. */
  inbound: string[];
  /** A quien le pega este servicio. */
  outbound: string[];
  /** Como se valida lo que entra. */
  auth: string;
  /** Lo que hay que saber antes de tocarlo. */
  gotcha?: string;
}

export const TOPOLOGY: ServiceTopology[] = [
  // --- PMS -----------------------------------------------------------------
  {
    id: "pms-app",
    layer: "interfaz",
    localPort: 9000,
    techIds: ["nextjs", "react", "tanstack-query"],
    datastore: null,
    inbound: ["Navegador del staff"],
    outbound: [
      "pms-api",
      "booking-api",
      "internal-api (widget de Roombir IA)",
      "iframes de Reservas, Habitaciones y Revenue",
      "Cloudinary",
      "Pusher",
    ],
    auth: "app_token httpOnly + JWT de staff en las llamadas",
    gotcha:
      "Trae Puppeteer para capturar portadas y screenshots: es la unica interfaz del stack que ejecuta un navegador del lado del servidor.",
  },
  {
    id: "pms-api",
    layer: "api",
    localPort: 9090,
    techIds: ["express", "mongoose", "jwt", "socketio", "pusher"],
    datastore: "pms",
    inbound: [
      "pms-app",
      "booking-api y rooms-api (llamadas de servicio)",
      "internal-api (JWT delegado del agente)",
    ],
    outbound: [
      "booking-api",
      "rooms-api",
      "internal-api",
      "Auth0",
      "Resend",
      "Cloudinary",
      "MaxMind / IPinfo",
      "Anthropic y OpenRouter",
    ],
    auth: "JWT de staff, con AGENT_JWT_SECRET aceptado en la misma lista",
    gotcha:
      "Es la API mas grande y la que mas terceros toca. Varias de sus rutas solo piden authenticateJWT sin mirar rol ni app: por eso el agente aplica su propia politica antes de llamarlas.",
  },

  // --- Reservas ------------------------------------------------------------
  {
    id: "booking-web",
    layer: "interfaz",
    localPort: 8000,
    basePath: "/reservas",
    techIds: ["nextjs", "react"],
    datastore: null,
    inbound: ["PMS, dentro de un iframe cross-origin"],
    outbound: ["booking-api"],
    auth: "JWT de staff heredado del PMS",
    gotcha:
      "Es de OTRO origen que el PMS: cualquier cosa que tenga que cruzar (telemetria, foco, navegacion) necesita postMessage con las dos mitades escritas.",
  },
  {
    id: "booking-engine",
    layer: "interfaz",
    localPort: 7000,
    techIds: ["nextjs", "react"],
    datastore: null,
    inbound: ["Navegador del huesped", "Sitios de hoteles"],
    outbound: ["booking-api"],
    auth: "Publico. Sin sesion hasta que el huesped reserva.",
    gotcha:
      "Es lo unico del stack que factura solo. Caido no degrada el producto: pierde reservas.",
  },
  {
    id: "booking-api",
    layer: "api",
    localPort: 7070,
    techIds: ["express", "mongoose", "jwt"],
    datastore: "pms",
    inbound: [
      "booking-web y booking-engine",
      "pms-api",
      "rms-api",
      "internal-api (JWT delegado del agente)",
    ],
    outbound: ["pms-api", "rooms-api", "staypass-api", "Resend", "internal-api"],
    auth: "Tres puertas: JWT de staff, JWT de huesped y endpoints publicos del motor",
    gotcha:
      "El dia civil es medianoche UTC en disponibilidad y locks. Tratar una fecha como local rompe el calendario sin dar error.",
  },

  // --- Habitaciones --------------------------------------------------------
  {
    id: "rooms-web",
    layer: "interfaz",
    localPort: 4000,
    basePath: "/habitaciones",
    techIds: ["nextjs", "react"],
    datastore: null,
    inbound: ["PMS, dentro de un iframe cross-origin"],
    outbound: ["rooms-api"],
    auth: "JWT de staff heredado del PMS",
  },
  {
    id: "rooms-api",
    layer: "api",
    localPort: 4040,
    techIds: ["express", "mongoose", "jwt", "socketio"],
    datastore: "pms",
    inbound: ["rooms-web", "pms-api", "booking-api", "internal-api"],
    outbound: ["pms-api", "Cloudinary"],
    auth: "JWT de staff, con AGENT_JWT_SECRET aceptado",
    gotcha:
      "Acepta cuatro nombres de secreto distintos (JWT, PMS_JWT, CORE_JWT, SHARED_JWT). Es historia acumulada, no diseno.",
  },

  // --- Revenue -------------------------------------------------------------
  {
    id: "rms-web",
    layer: "interfaz",
    localPort: 3300,
    basePath: "/revenue",
    techIds: ["nextjs", "react", "tanstack-query"],
    datastore: null,
    inbound: ["PMS, dentro de un iframe cross-origin"],
    outbound: ["rms-api"],
    auth: "JWT de staff heredado del PMS",
    gotcha:
      "Sigue en Next 14.2, cuatro mayores atras del resto. De ahi salio el bug de hidratacion que dejaba la pantalla en 'Cargando contexto...'.",
  },
  {
    id: "rms-api",
    layer: "api",
    localPort: 3030,
    techIds: ["express", "mongoose", "jwt"],
    datastore: "rms",
    inbound: ["rms-web", "booking-api"],
    outbound: [
      "pms-api",
      "booking-api",
      "internal-api (intelligence hub)",
      "Ticketmaster",
    ],
    auth: "JWT de staff + RMS_INTERNAL_SECRET para el trafico de servicio",
    gotcha:
      "Es el unico que escribe en su propia base. Para cruzar con datos del PMS no hace un $lookup: sale por HTTP.",
  },

  // --- Huesped -------------------------------------------------------------
  {
    id: "staypass-web",
    layer: "interfaz",
    localPort: 5000,
    techIds: ["nextjs", "react"],
    datastore: null,
    inbound: ["Navegador del huesped"],
    outbound: ["staypass-api"],
    auth: "JWT de huesped",
  },
  {
    id: "staypass-api",
    layer: "api",
    localPort: 5050,
    techIds: ["express", "mongoose", "jwt", "socketio"],
    datastore: "pms",
    inbound: ["staypass-web", "booking-api"],
    outbound: ["Resend", "internal-api"],
    auth: "GUEST_JWT_SECRET, un secreto propio que no comparte con el staff",
    gotcha:
      "El huesped nunca ve un JWT de staff, y el staff nunca uno de huesped: son dos universos de identidad separados a proposito.",
  },

  // --- Publico -------------------------------------------------------------
  {
    id: "mkt-renderer",
    layer: "interfaz",
    localPort: 6300,
    techIds: ["nextjs", "react", "coolify"],
    datastore: null,
    inbound: ["Publico y buscadores"],
    outbound: ["internal-api (alta de leads)"],
    auth: "Publico",
    gotcha:
      "El panel edita este repo por filesystem pero NO commitea ni pushea, y el deploy sale de GitHub: un cambio en Marketing > Sitio no llega a produccion hasta que alguien pushee.",
  },
  {
    id: "linkhub-renderer",
    layer: "interfaz",
    localPort: 6200,
    techIds: ["nextjs", "react"],
    datastore: null,
    inbound: ["Publico, desde las redes del hotel"],
    outbound: ["pms-api"],
    auth: "Publico",
  },
  {
    id: "web-renderer",
    layer: "interfaz",
    localPort: 6100,
    techIds: ["nextjs", "react", "docker", "traefik", "letsencrypt"],
    datastore: null,
    inbound: [
      "Publico, por *.sites.roombir.com o por el dominio propio del hotel",
      "pms-api (revalidacion)",
    ],
    outbound: ["pms-api", "booking-api", "staypass-web"],
    auth: "Publico, salvo la revalidacion que pide REVALIDATE_SECRET",
    gotcha:
      "Es multi-tenant: un solo deploy sirve todos los sitios. Traefik le PREGUNTA a el que dominios enrutar, asi que agregar un dominio de hotel no toca la configuracion del proxy.",
  },

  // --- Interno -------------------------------------------------------------
  {
    id: "internal-web",
    layer: "interfaz",
    localPort: 8500,
    techIds: [
      "vite",
      "react",
      "tailwind",
      "tanstack-query",
      "react-router",
      "maplibre",
    ],
    datastore: null,
    inbound: ["Navegador del equipo interno"],
    outbound: ["internal-api"],
    auth: "JWT propio del panel, 8 h, en localStorage",
  },
  {
    id: "internal-api",
    layer: "api",
    localPort: 8600,
    techIds: ["express", "mongoose", "jwt", "anthropic", "openai", "gemini"],
    datastore: "internal",
    inbound: [
      "internal-web",
      "pms-app (widget de Roombir IA)",
      "booking-api, staypass-api y web-renderer (ingesta)",
      "rms-api (intelligence hub)",
      "mkt-renderer (leads publicos)",
    ],
    outbound: [
      "Las cinco APIs del stack, con JWT delegado",
      "Anthropic, OpenAI, Gemini y OpenRouter",
      "trends-service",
      "Vercel, Coolify, GitHub y Cloudflare",
      "Decenas de fuentes abiertas de los hubs de /global",
    ],
    auth:
      "JWT propio para el panel, X-Internal-Secret para el runtime del agente y la ingesta",
    gotcha:
      "Abre DOS conexiones a Mongo: la suya de escritura y una secundaria de solo lectura contra la base del PMS. Es el unico servicio que lee datos de otro producto sin pasar por su API.",
  },
  {
    id: "trends-service",
    layer: "api",
    localPort: 8700,
    techIds: ["python", "fastapi", "docker"],
    datastore: null,
    inbound: ["internal-api, por red interna del VPS"],
    outbound: ["Google Trends"],
    auth: "Ninguna. Por eso NO tiene hostname publico.",
    gotcha:
      "Que no tenga autenticacion es la razon de que no se publique. Si alguien le pone un dominio, queda abierto a internet.",
  },
];

export const TOPOLOGY_BY_ID = new Map(TOPOLOGY.map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// Bases de datos
// ---------------------------------------------------------------------------

export interface Datastore {
  id: string;
  /** Nombre real de la base en el cluster. */
  name: string;
  engine: string;
  purpose: string;
  /** Ids de servicios que escriben. */
  writers: string[];
  /** Ids de servicios que leen sin escribir. */
  readers: string[];
  note?: string;
}

export const DATASTORES: Datastore[] = [
  {
    id: "pms",
    name: "elippser-sites_tests",
    engine: "MongoDB Atlas",
    purpose:
      "El corazon del producto: cuentas, propiedades, usuarios, unidades, tarifas, reservas y sitios.",
    writers: ["pms-api", "booking-api", "rooms-api", "staypass-api"],
    readers: ["internal-api"],
    note:
      "Cuatro APIs escriben la MISMA base sin un duenio unico por coleccion. No hay transacciones cruzadas: la consistencia depende de que cada una respete el modelo de la otra. El nombre quedo de la epoca anterior al rename y no describe lo que contiene.",
  },
  {
    id: "internal",
    name: "laupser_internal",
    engine: "MongoDB Atlas",
    purpose:
      "El panel interno y el motor agentico: agentes, conversaciones, KBs, tickets, metricas, leads, prospectos y competencia.",
    writers: ["internal-api"],
    readers: [],
    note:
      "Vive en el MISMO cluster que la base del PMS. Separadas logicamente, no fisicamente: comparten CPU, memoria y limite de conexiones.",
  },
  {
    id: "rms",
    name: "laupser_rms",
    engine: "MongoDB Atlas",
    purpose:
      "Revenue management: pickup, pace, compset, eventos y recomendaciones de precio.",
    writers: ["rms-api"],
    readers: ["internal-api"],
    note:
      "La unica base con un solo escritor. El precio de esa limpieza es que todo cruce con datos del PMS sale por HTTP.",
  },
];

// ---------------------------------------------------------------------------
// Canales de integracion
// ---------------------------------------------------------------------------

export type ChannelKind =
  | "jwt"
  | "secret"
  | "iframe"
  | "realtime"
  | "webhook"
  | "db";

export interface Channel {
  id: string;
  label: string;
  kind: ChannelKind;
  from: string;
  to: string;
  /**
   * Ids de los servicios que el cable toca, en cualquiera de las dos puntas.
   *
   * Va explicito y no se deduce de `from`/`to`: esos son texto para leer
   * ("Navegador del hotelero", "Las cuatro APIs del staff") y buscar el id
   * adentro fallaba justo en los canales mas importantes, los que enumeran a
   * varios servicios de golpe.
   */
  services: string[];
  /** Que viaja por el cable. */
  carries: string;
  /** La env var que lo abre. `null` = no hay secreto (publico o postMessage). */
  secret: string | null;
  note?: string;
}

export const CHANNELS: Channel[] = [
  {
    id: "staff-jwt",
    label: "JWT de staff",
    kind: "jwt",
    from: "Navegador del hotelero",
    to: "Las cuatro APIs del staff",
    services: [
      "pms-app",
      "booking-web",
      "rooms-web",
      "rms-web",
      "pms-api",
      "booking-api",
      "rooms-api",
      "rms-api",
    ],
    carries: "userId, companyId y rol del hotelero",
    secret: "JWT_SECRET / STAFF_JWT_SECRET / SHARED_JWT_SECRET",
    note:
      "Cada API acepta una lista de secretos, no uno solo. Por eso una rotacion mal hecha da 401 en un servicio y no en los otros. Ojo con los caracteres que dotenv corta: un '#' en el valor trunca el secreto sin avisar.",
  },
  {
    id: "guest-jwt",
    label: "JWT de huesped",
    kind: "jwt",
    from: "Navegador del huesped",
    to: "staypass-api y booking-api",
    services: ["booking-engine", "staypass-web", "staypass-api", "booking-api"],
    carries: "Identidad del huesped y su reserva",
    secret: "GUEST_JWT_SECRET",
    note:
      "Secreto propio, separado del de staff. Un token de huesped nunca puede autorizar una operacion de staff aunque llegue a la misma API.",
  },
  {
    id: "agent-jwt",
    label: "JWT delegado del agente",
    kind: "jwt",
    from: "internal-api (runtime de Roombir IA)",
    to: "pms-api, booking-api, rooms-api, rms-api",
    services: [
      "internal-api",
      "pms-api",
      "booking-api",
      "rooms-api",
      "rms-api",
      "staypass-api",
    ],
    carries: "La identidad del hotelero real, suplantada por el agente",
    secret: "AGENT_JWT_SECRET",
    note:
      "TTL de 3 minutos y se re-mintea en CADA tool call, resolviendo el rol fresco desde las memberships. Si le revocan el acceso a mitad de conversacion, la siguiente accion falla con 403 y el agente lo explica.",
  },
  {
    id: "internal-secret",
    label: "X-Internal-Secret",
    kind: "secret",
    from: "pms-app y las APIs del producto",
    to: "internal-api",
    services: [
      "pms-app",
      "internal-api",
      "pms-api",
      "booking-api",
      "staypass-api",
      "web-renderer",
      "mkt-renderer",
    ],
    carries:
      "Trafico de servicio: runtime del chat, ingesta de analytics, notificaciones",
    secret: "PMS_INTERNAL_SECRET / INTERNAL_ROOMBIR_SECRET",
    note:
      "No son el mismo valor en todos los repos, y esa diferencia ya rompio produccion una vez. Al rotar secretos, internal-api es el que se olvida.",
  },
  {
    id: "rms-secret",
    label: "Secreto de servicio del RMS",
    kind: "secret",
    from: "booking-api",
    to: "rms-api",
    services: ["booking-api", "rms-api"],
    carries: "Hechos de reservas para el pickup y el pace",
    secret: "RMS_INTERNAL_SECRET",
  },
  {
    id: "intel-secret",
    label: "Intelligence hub",
    kind: "secret",
    from: "rms-api",
    to: "internal-api",
    services: ["rms-api", "internal-api"],
    carries: "Senales de demanda: eventos, clima, feriados, conectividad",
    secret: "INTELLIGENCE_HUB_SECRET",
    note:
      "El hub de inteligencia vive en el panel interno, no en el RMS. El RMS es un consumidor mas de los mismos conectores que alimentan /global.",
  },
  {
    id: "front-proxy",
    label: "Puente de IP real",
    kind: "secret",
    from: "pms-app (servidor de Next)",
    to: "pms-api",
    services: ["pms-app", "pms-api"],
    carries: "La IP y el user-agent originales del usuario",
    secret: "FRONT_PROXY_SECRET",
    note:
      "Existe porque el login y el intercambio con Auth0 los hace el servidor de Next: sin este puente, la bitacora de accesos registra la IP del servidor y el bloqueo por pais es inutil.",
  },
  {
    id: "revalidate",
    label: "Revalidacion de sitios",
    kind: "secret",
    from: "pms-core (builder de sitios)",
    to: "web-renderer",
    services: ["pms-app", "pms-api", "web-renderer"],
    carries: "La orden de regenerar las paginas de un sitio publicado",
    secret: "REVALIDATE_SECRET",
    note:
      "Sin esto, publicar un cambio en el builder no se ve hasta que expira el cache del renderer.",
  },
  {
    id: "iframes",
    label: "Iframes del PMS",
    kind: "iframe",
    from: "pms-app",
    to: "booking-web, rooms-web, rms-web",
    services: ["pms-app", "booking-web", "rooms-web", "rms-web"],
    carries: "Las tres apps embebidas bajo /reservas, /habitaciones y /revenue",
    secret: null,
    note:
      "Son de OTRO origen. Todo lo que tenga que cruzar el borde -telemetria, navegacion, tamano- necesita postMessage con las dos mitades implementadas. Es la trampa que mas veces parecio 'el boton no hace nada'.",
  },
  {
    id: "pusher",
    label: "Notificaciones del PMS",
    kind: "realtime",
    from: "pms-api",
    to: "Navegador del staff",
    services: ["pms-api", "pms-app"],
    carries: "Avisos en vivo dentro del PMS",
    secret: "PUSHER_APP_ID / PUSHER_KEY / PUSHER_SECRET",
    note: "SaaS con cuota: se paga por mensaje.",
  },
  {
    id: "sockets",
    label: "Websockets de operacion",
    kind: "realtime",
    from: "rooms-api y staypass-api",
    to: "Navegador del staff y del huesped",
    services: ["rooms-api", "staypass-api"],
    carries: "Estado de habitaciones y de la estadia, en vivo",
    secret: null,
    note:
      "Hace casi lo mismo que Pusher, con otra tecnologia y otro camino. Son dos sistemas de tiempo real conviviendo.",
  },
  {
    id: "github-webhook",
    label: "Webhook de GitHub",
    kind: "webhook",
    from: "GitHub",
    to: "internal-api",
    services: ["internal-api"],
    carries: "Eventos de push y de deploy",
    secret: "GITHUB_WEBHOOK_SECRET",
  },
  {
    id: "pms-db-ro",
    label: "Lectura directa de la base del PMS",
    kind: "db",
    from: "internal-api",
    to: "elippser-sites_tests",
    services: ["internal-api"],
    carries: "companies y properties, en solo lectura",
    secret: "PMS_MONGODB_URI",
    note:
      "Existe porque pms-api no expone rutas admin para listar todas las cuentas. Es un atajo consciente: el dia que existan esas rutas, migrar a HTTP es cambiar un modulo.",
  },
];

// ---------------------------------------------------------------------------
// Recorridos punta a punta
// ---------------------------------------------------------------------------

export interface FlowStep {
  from: string;
  to: string;
  what: string;
  note?: string;
}

export interface Flow {
  id: string;
  label: string;
  /** La pregunta que responde el recorrido. */
  question: string;
  /** Ids de servicios que participan, en orden de aparicion. */
  actors: string[];
  steps: FlowStep[];
  /** Donde se rompe en la practica. */
  gotcha?: string;
}

export const FLOWS: Flow[] = [
  {
    id: "reserva",
    label: "Una reserva del huesped",
    question:
      "Desde que el huesped busca fechas hasta que la reserva aparece en el PMS.",
    actors: [
      "booking-engine",
      "booking-api",
      "web-renderer",
      "staypass-api",
      "pms-app",
    ],
    steps: [
      {
        from: "Huesped",
        to: "booking-engine",
        what: "Entra al motor, por link directo o desde el sitio del hotel.",
      },
      {
        from: "booking-engine",
        to: "booking-api",
        what: "Consulta disponibilidad y tarifas para el rango pedido.",
        note: "Endpoint publico: sin JWT, solo el identificador de la propiedad.",
      },
      {
        from: "booking-api",
        to: "MongoDB",
        what: "Lee Availability y locks. El dia civil es medianoche UTC.",
      },
      {
        from: "booking-engine",
        to: "booking-api",
        what: "Confirma la reserva con los datos del huesped.",
        note: "El telefono se guarda normalizado en E.164, en un solo campo.",
      },
      {
        from: "booking-api",
        to: "Resend",
        what: "Manda la confirmacion al huesped.",
        note:
          "Sale de un remitente propio de la plataforma; el hotel entra como Reply-To. El hotel no configura SMTP.",
      },
      {
        from: "booking-api",
        to: "internal-api",
        what: "Emite el evento de analytics del funnel del motor.",
      },
      {
        from: "pms-app",
        to: "booking-api",
        what: "El staff ve la reserva en el hub /reservas, dentro del PMS.",
      },
    ],
    gotcha:
      "Es el unico recorrido que factura solo. Todo lo demas del stack puede degradarse; esto caido son reservas perdidas.",
  },
  {
    id: "turno-ia",
    label: "Un turno de Roombir IA",
    question:
      "Que pasa entre que el hotelero escribe en el chat y el agente ejecuta algo en el PMS.",
    actors: ["pms-app", "internal-api", "pms-api", "booking-api", "rooms-api"],
    steps: [
      {
        from: "pms-app",
        to: "internal-api",
        what: "Abre la sesion con X-Internal-Secret y el JWT del hotelero en el contexto.",
        note:
          "El widget corre dentro del PMS, pero el runtime del agente vive entero en el panel interno.",
      },
      {
        from: "internal-api",
        to: "pms-api",
        what: "Resuelve el alcance del usuario: rol, capabilities, apps del espacio activo.",
        note:
          "Misma fuente que usa el PMS para dibujar sus pantallas. Cache de 60 s.",
      },
      {
        from: "internal-api",
        to: "internal-api",
        what: "Filtra las tools segun ese alcance ANTES de armar el turno.",
        note:
          "Lo que el usuario no puede hacer no se le ofrece al modelo. Evita que el agente prometa algo condenado al 403.",
      },
      {
        from: "internal-api",
        to: "OpenAI",
        what: "Embebe la consulta para recuperar los chunks de la KB.",
        note: "Si no hay clave, cae a un hash determinista y recupera peor.",
      },
      {
        from: "internal-api",
        to: "Anthropic",
        what: "Manda prompt, historial, contexto y tools disponibles.",
      },
      {
        from: "internal-api",
        to: "APIs del PMS",
        what: "Ejecuta la tool con un JWT delegado de 3 minutos.",
        note:
          "El JWT suplanta al hotelero real: la autorizacion de verdad la sigue aplicando cada API.",
      },
      {
        from: "internal-api",
        to: "MongoDB",
        what: "Persiste mensajes, tokens, trazas y el consumo del plan.",
      },
    ],
    gotcha:
      "Tres eslabones tienen que estar bien a la vez: el secreto interno, la version publicada del agente y el cupo del plan. Si falla uno, el sintoma es el mismo -el chat no contesta- y no dice cual.",
  },
  {
    id: "sitio-hotel",
    label: "Publicar el sitio de un hotel",
    question: "Desde el builder del PMS hasta el dominio propio del hotel.",
    actors: ["pms-app", "pms-api", "web-renderer"],
    steps: [
      {
        from: "pms-app",
        to: "pms-api",
        what: "El hotelero edita el sitio en el builder y guarda.",
      },
      {
        from: "pms-api",
        to: "MongoDB",
        what: "Guarda la estructura del sitio y las paginas.",
      },
      {
        from: "pms-api",
        to: "Cloudinary",
        what: "Sube las imagenes del sitio.",
      },
      {
        from: "pms-core",
        to: "web-renderer",
        what: "Pide revalidar las paginas con REVALIDATE_SECRET.",
      },
      {
        from: "Huesped",
        to: "Traefik",
        what: "Entra por el dominio propio del hotel o por *.sites.roombir.com.",
      },
      {
        from: "Traefik",
        to: "web-renderer",
        what: "Pregunta al renderer que dominios sirve y enruta.",
        note:
          "Provider @http: agregar un dominio de hotel no toca la configuracion del proxy.",
      },
      {
        from: "web-renderer",
        to: "pms-api",
        what: "Lee el sitio y lo renderiza con el tema del hotel.",
      },
    ],
    gotcha:
      "El wildcard *.sites.roombir.com tiene que estar en GRIS en Cloudflare. En naranja el certificado no cubre el segundo nivel y cualquier preview da error.",
  },
  {
    id: "alta-cuenta",
    label: "El alta de una cuenta",
    question: "Como entra un hotel nuevo a la plataforma.",
    actors: ["mkt-renderer", "internal-api", "internal-web", "pms-api", "pms-app"],
    steps: [
      {
        from: "Interesado",
        to: "mkt-renderer",
        what: "Pide acceso desde el sitio publico.",
      },
      {
        from: "mkt-renderer",
        to: "internal-api",
        what: "Crea el lead en la base interna.",
      },
      {
        from: "internal-web",
        to: "internal-api",
        what: "El equipo revisa el lead y manda la invitacion.",
      },
      {
        from: "internal-api",
        to: "Resend",
        what: "Envia el mail con el enlace de invitacion.",
      },
      {
        from: "Interesado",
        to: "pms-api",
        what: "Se registra con la invitacion y queda la cuenta creada.",
        note:
          "REGISTER_REQUIRE_INVITE cierra el porton: sin invitacion valida el registro se rechaza.",
      },
      {
        from: "pms-app",
        to: "pms-api",
        what: "Arranca el onboarding: propiedad, unidades, tarifas, motor.",
      },
    ],
    gotcha:
      "El porton falla cerrado y la cadena cruza cuatro repos. Si uno de los cuatro queda desactualizado, el alta se corta sin un error claro.",
  },
  {
    id: "deploy",
    label: "Un deploy, de push a produccion",
    question: "Que pasa desde que se pushea hasta que el dominio sirve lo nuevo.",
    actors: [],
    steps: [
      {
        from: "Persona",
        to: "GitHub",
        what: "Pushea al repo del servicio.",
        note:
          "Cada servicio es su PROPIO repo. No hay un push que despliegue la plataforma entera.",
      },
      {
        from: "GitHub",
        to: "Vercel o Coolify",
        what: "Dispara el build del proyecto conectado a ese repo.",
      },
      {
        from: "Build",
        to: "Produccion",
        what: "Vercel promueve el deploy; en el VPS, Coolify levanta el contenedor.",
      },
      {
        from: "Cloudflare",
        to: "Usuario",
        what: "El hostname ya apuntaba: no hay cambio de DNS en un deploy normal.",
      },
    ],
    gotcha:
      "El paquete compartido @roombir/ui es una dependencia file: que vive fuera del repo. Sin correr `npm run sync:ui`, npm ci NO falla pero el build revienta con 'Module not found'.",
  },
  {
    id: "senales-demanda",
    label: "Las senales de demanda del RMS",
    question: "De donde saca el RMS que va a pasar en el destino.",
    actors: ["rms-api", "internal-api", "trends-service"],
    steps: [
      {
        from: "rms-api",
        to: "internal-api",
        what: "Pide senales para la ciudad y el rango, con INTELLIGENCE_HUB_SECRET.",
      },
      {
        from: "internal-api",
        to: "Fuentes abiertas",
        what: "Corre los conectores: eventos, feriados, clima, vuelos, atencion.",
        note:
          "Los mismos conectores que alimentan los hubs de /global. Una sola implementacion, dos consumidores.",
      },
      {
        from: "internal-api",
        to: "trends-service",
        what: "Consulta Google Trends por la red interna del VPS.",
      },
      {
        from: "rms-api",
        to: "MongoDB",
        what: "Guarda las senales junto al pickup y al pace para recomendar precio.",
      },
    ],
    gotcha:
      "Varios conectores devuelven datos plausibles cuando fallan en vez de romper. Un espejo de Overpass que solo tiene Suiza contesta 200 vacio y gana el failover en silencio.",
  },
];

// ---------------------------------------------------------------------------
// Cruces
// ---------------------------------------------------------------------------

/**
 * Servicios del inventario de infraestructura que todavia no tienen fila en
 * TOPOLOGY. Se expone en el endpoint para que el hueco se vea en el panel en
 * vez de quedar como un servicio que "no aparece".
 */
export function missingTopology(): string[] {
  return INFRA_SERVICES.filter((s) => !TOPOLOGY_BY_ID.has(s.id)).map((s) => s.id);
}

/** Lo inverso: filas de TOPOLOGY que apuntan a un servicio que ya no existe. */
export function orphanTopology(): string[] {
  const ids = new Set(INFRA_SERVICES.map((s) => s.id));
  return TOPOLOGY.filter((t) => !ids.has(t.id)).map((t) => t.id);
}

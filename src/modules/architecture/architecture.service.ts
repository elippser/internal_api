/**
 * Arma el panorama de arquitectura.
 *
 * NO SALE A LA RED. Ni una llamada, ni a Vercel ni a GitHub ni a npm. Todo lo
 * que sirve esta pantalla sale de leer el codigo del monorepo, y esa es la
 * diferencia con el modulo de Infraestructura: aquel pregunta "como esta ahora"
 * y necesita tokens; este responde "como esta hecho" y no necesita nada.
 *
 * Consecuencia practica: es instantaneo, no gasta presupuesto de la cuenta
 * Hobby de Vercel y funciona igual con todos los proveedores caidos.
 */

import {
  INFRA_SERVICES,
  SERVICES_BY_ID,
  hostsOf,
  type InfraService,
} from "../infra/infra.inventory";
import {
  AUDIENCES,
  CHANNELS,
  DATASTORES,
  FLOWS,
  LAYERS,
  TOPOLOGY,
  TOPOLOGY_BY_ID,
  missingTopology,
  orphanTopology,
  type Channel,
  type Datastore,
  type Flow,
  type LayerId,
  type ServiceTopology,
} from "./architecture.inventory";
import {
  TECHNOLOGIES,
  TECH_BY_ID,
  TECH_CATEGORIES,
  techForService,
  type Tech,
  type TechCategory,
} from "./architecture.tech";

// ---------------------------------------------------------------------------
// Tipos de salida
// ---------------------------------------------------------------------------

/** Un servicio con todo lo que sabemos de el, de las dos tablas juntas. */
export interface ArchitectureService extends InfraService {
  layer: LayerId | null;
  localPort: number | null;
  basePath?: string;
  datastore: { id: string; name: string } | null;
  inbound: string[];
  outbound: string[];
  auth: string | null;
  gotcha?: string;
  /** Tecnologias declaradas en la topologia mas las que se declaran a si mismas. */
  tech: { id: string; name: string; logo: string | null; version: string | null }[];
  hosts: string[];
}

/**
 * Lo que ocupa una capa que no tiene procesos propios.
 *
 * Cuatro de las seis capas no son servicios nuestros: quien mira, el borde,
 * las bases y los terceros. Dibujarlas vacias seria dar a entender que el
 * sistema empieza en las interfaces y termina en las APIs, que es exactamente
 * la lectura equivocada.
 */
export interface LayerChip {
  label: string;
  sub: string;
  logo: string | null;
}

/**
 * Una observacion sobre el estado del stack. Es la parte de "analisis" del
 * modulo: no describe, opina, y por eso cada una lleva su evidencia.
 */
export interface Finding {
  id: string;
  title: string;
  /** `riesgo` = puede romper produccion. `deuda` = cuesta plata o tiempo. */
  severity: "riesgo" | "deuda" | "nota";
  detail: string;
  /** De donde sale el dato. */
  evidence: string;
}

// ---------------------------------------------------------------------------
// Armado
// ---------------------------------------------------------------------------

function techSummary(t: Tech) {
  return { id: t.id, name: t.name, logo: t.logo, version: t.version };
}

/** Une el inventario de infraestructura con la topologia y las tecnologias. */
function buildService(svc: InfraService): ArchitectureService {
  const topo: ServiceTopology | undefined = TOPOLOGY_BY_ID.get(svc.id);
  const store = topo?.datastore
    ? DATASTORES.find((d) => d.id === topo.datastore)
    : undefined;

  // Dos fuentes para las tecnologias de un servicio, y hay que unirlas: la
  // topologia lista las que definen el runtime, y el catalogo tiene entradas
  // que se declaran a si mismas (Vercel, Cloudflare) sin estar en la fila.
  const ids = new Set(topo?.techIds ?? []);
  for (const t of techForService(svc.id)) ids.add(t.id);

  const tech = [...ids]
    .map((id) => TECH_BY_ID.get(id))
    .filter((t): t is Tech => Boolean(t))
    .map(techSummary);

  return {
    ...svc,
    layer: topo?.layer ?? null,
    localPort: topo?.localPort ?? null,
    ...(topo?.basePath ? { basePath: topo.basePath } : {}),
    datastore: store ? { id: store.id, name: store.name } : null,
    inbound: topo?.inbound ?? [],
    outbound: topo?.outbound ?? [],
    auth: topo?.auth ?? null,
    ...(topo?.gotcha ? { gotcha: topo.gotcha } : {}),
    tech,
    hosts: hostsOf(svc),
  };
}

/**
 * Que va en cada capa sin servicios propios. Todo se DERIVA de las tablas —
 * el borde y los terceros salen del catalogo de tecnologias, las bases de
 * DATASTORES — asi que agregar una tecnologia externa la hace aparecer en el
 * mapa sin tocar esta funcion.
 */
function chipsFor(layer: LayerId): LayerChip[] {
  if (layer === "cliente") {
    return AUDIENCES.map((a) => ({ label: a.label, sub: a.sub, logo: null }));
  }

  if (layer === "borde") {
    // Los tres que deciden que proceso atiende un pedido, en ese orden.
    return ["cloudflare", "vercel", "coolify", "traefik"]
      .map((id) => TECH_BY_ID.get(id))
      .filter((t): t is Tech => Boolean(t))
      .map((t) => ({ label: t.name, sub: t.role, logo: t.logo }));
  }

  if (layer === "datos") {
    return DATASTORES.map((d) => ({
      label: d.name,
      sub: `${d.writers.length} escriben, ${d.readers.length} leen`,
      logo: "mongodb",
    }));
  }

  if (layer === "terceros") {
    return TECHNOLOGIES.filter(
      (t) => t.category === "ia" || t.category === "externo",
    ).map((t) => ({ label: t.name, sub: t.role, logo: t.logo }));
  }

  return [];
}

/**
 * Las observaciones. Las que se pueden contar se cuentan; las que son juicio
 * llevan su evidencia al lado para que se puedan discutir con el archivo abierto.
 */
function buildFindings(services: ArchitectureService[]): Finding[] {
  const out: Finding[] = [];

  const sinRepo = services.filter((s) => !s.githubRepo);
  if (sinRepo.length > 0) {
    out.push({
      id: "sin-repo",
      title: `${sinRepo.length} servicios sin repositorio en GitHub`,
      severity: "riesgo",
      detail:
        `${sinRepo.map((s) => s.label).join(", ")}. Sin remoto no se despliegan desde git: ` +
        "alguien los sube a mano, y no hay historial de que version esta en produccion.",
      evidence: "githubRepo: null en infra.inventory.ts",
    });
  }

  const writersPms = DATASTORES.find((d) => d.id === "pms")?.writers.length ?? 0;
  out.push({
    id: "base-compartida",
    title: `${writersPms} APIs escriben la misma base`,
    severity: "riesgo",
    detail:
      "PMS, Reservas, Habitaciones y StayPass comparten elippser-sites_tests sin un duenio unico por coleccion. " +
      "No hay transacciones cruzadas: la consistencia depende de que cada API respete el modelo de las otras.",
    evidence: "MONGODB_URI / DATABASE_MDB de los cuatro .env.production",
  });

  out.push({
    id: "next-desparejo",
    title: "Cuatro mayores de Next.js conviviendo",
    severity: "deuda",
    detail:
      "16.2.x en Reservas, Motor y los renderers; 15.x en PMS, Habitaciones y StayPass; ~14.2 en Revenue. " +
      "Quedarse atras no es gratis: el bug de hidratacion de Revenue salio justamente de eso.",
    evidence: "dependencies de los 9 frontends Next",
  });

  out.push({
    id: "tiempo-real-doble",
    title: "Dos sistemas de tiempo real para lo mismo",
    severity: "deuda",
    detail:
      "Pusher mueve las notificaciones del PMS y Socket.IO el estado de habitaciones y de la estadia. " +
      "Uno es SaaS con cuota por mensaje y el otro corre en nuestros procesos.",
    evidence: "pusherBus.ts en pms-core/api, socket.io en rooms-app/api y staypass-app/api",
  });

  const coolify = services.filter((s) => s.provider === "coolify");
  out.push({
    id: "vps-unico",
    title: `${coolify.length} servicios dependen de un solo VPS`,
    severity: "riesgo",
    detail:
      `${coolify.map((s) => s.label).join(", ")}. Es el unico lugar del stack sin failover: ` +
      "Vercel se recupera solo, el VPS no. Los sitios de hoteles estan de ese lado.",
    evidence: "provider: coolify en infra.inventory.ts",
  });

  out.push({
    id: "secretos-multiples",
    title: "Cinco familias de secreto JWT en circulacion",
    severity: "riesgo",
    detail:
      "Staff, compartido, agente, huesped y el propio del panel. Cada API acepta una LISTA de secretos, " +
      "asi que una rotacion incompleta da 401 en un servicio y no en los otros. dotenv ademas corta el valor en el '#'.",
    evidence: "*_JWT_SECRET en los .env de las 6 APIs",
  });

  out.push({
    id: "ui-vendoreada",
    title: "@roombir/ui viaja copiada dentro de cada repo",
    severity: "nota",
    detail:
      "La fuente vive en packages/ del monorepo y `npm run sync:ui` la copia a cada app. " +
      "Sin correrlo, npm ci NO falla pero el build de produccion revienta con 'Module not found'.",
    evidence: "scripts/sync-roombir-ui.mjs",
  });

  out.push({
    id: "sdk-anthropic",
    title: "El SDK de Anthropic va desparejo entre repos",
    severity: "deuda",
    detail:
      "pms-core/api esta en ^0.95.2 y el panel interno en ^0.27.3. Es la brecha de version mas grande del stack " +
      "y esta justo en el camino de la funcionalidad que se cobra.",
    evidence: "@anthropic-ai/sdk en los dos package.json",
  });

  out.push({
    id: "sin-pagos",
    title: "No hay pasarela de pagos integrada",
    severity: "nota",
    detail:
      "Ninguna API declara un SDK de cobro. Los importes de las reservas son registros propios, " +
      "no cobros procesados: el dinero se mueve fuera de la plataforma.",
    evidence: "dependencies de las 6 APIs",
  });

  const faltantes = missingTopology();
  if (faltantes.length > 0) {
    out.push({
      id: "topologia-incompleta",
      title: `${faltantes.length} servicios sin analizar`,
      severity: "nota",
      detail:
        `Estan en el inventario de infraestructura pero no tienen fila en la topologia: ${faltantes.join(", ")}. ` +
        "Agregarlos en architecture.inventory.ts.",
      evidence: "cruce entre INFRA_SERVICES y TOPOLOGY",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// API del modulo
// ---------------------------------------------------------------------------

export const architectureService = {
  /** El panorama: capas, conteos y observaciones. Es la pantalla de entrada. */
  overview() {
    const services = INFRA_SERVICES.map(buildService);

    const layers = LAYERS.map((l) => ({
      ...l,
      chips: chipsFor(l.id),
      services: services
        .filter((s) => s.layer === l.id)
        .map((s) => ({
          id: s.id,
          label: s.label,
          kind: s.kind,
          provider: s.provider,
          host: s.host,
          criticality: s.criticality,
          stack: s.stack,
          basePath: s.basePath ?? null,
          logo: s.tech[0]?.logo ?? null,
        })),
    }));

    const byCategory = TECH_CATEGORIES.map((c) => ({
      ...c,
      count: TECHNOLOGIES.filter((t) => t.category === c.id).length,
    }));

    return {
      summary: {
        services: services.length,
        technologies: TECHNOLOGIES.length,
        datastores: DATASTORES.length,
        channels: CHANNELS.length,
        flows: FLOWS.length,
        repos: services.filter((s) => s.githubRepo).length,
        core: services.filter((s) => s.criticality === "core").length,
        providers: {
          vercel: services.filter((s) => s.provider === "vercel").length,
          coolify: services.filter((s) => s.provider === "coolify").length,
        },
      },
      layers,
      categories: byCategory,
      datastores: DATASTORES,
      findings: buildFindings(services),
      /** Huecos del propio inventario, para que se vean en vez de esconderse. */
      integrity: {
        missingTopology: missingTopology(),
        orphanTopology: orphanTopology(),
      },
    };
  },

  /** El catalogo de tecnologias, opcionalmente filtrado. */
  stack(params: { category?: TechCategory; q?: string }) {
    let list = TECHNOLOGIES;

    if (params.category) {
      list = list.filter((t) => t.category === params.category);
    }
    if (params.q) {
      const needle = params.q.trim().toLowerCase();
      list = list.filter((t) =>
        [t.name, t.role, t.version ?? "", t.evidence]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    }

    // Cada tecnologia viaja con los servicios donde corre ya resueltos: el
    // frontend no tiene por que saber como se traduce un id a una etiqueta.
    const data = list.map((t) => ({
      ...t,
      serviceLabels: t.services
        .map((id) => SERVICES_BY_ID.get(id)?.label)
        .filter((l): l is string => Boolean(l)),
    }));

    return {
      data,
      total: data.length,
      // El conteo va sobre el catalogo COMPLETO, no sobre `list`: es el numero
      // que el selector de categorias muestra al lado de cada opcion, y tiene
      // que decir cuantas hay para elegir, no cuantas quedaron del filtro
      // anterior.
      categories: TECH_CATEGORIES.map((c) => ({
        ...c,
        count: TECHNOLOGIES.filter((t) => t.category === c.id).length,
      })),
    };
  },

  /** Los servicios, con la topologia ya cruzada. */
  services() {
    const data = INFRA_SERVICES.map(buildService);
    return { data, total: data.length, layers: LAYERS };
  },

  /** Un servicio, con sus tecnologias completas, su base y sus canales. */
  detail(id: string) {
    const svc = SERVICES_BY_ID.get(id);
    if (!svc) {
      const err: any = new Error(`No existe el servicio "${id}"`);
      err.status = 404;
      err.code = "not_found";
      throw err;
    }

    const base = buildService(svc);
    const topo = TOPOLOGY_BY_ID.get(id);

    const tech = base.tech
      .map((t) => TECH_BY_ID.get(t.id))
      .filter((t): t is Tech => Boolean(t));

    // Los canales del servicio salen de la lista explicita de cada cable, no de
    // buscar el id dentro de `from`/`to`. Esos dos campos son texto para leer y
    // a veces nombran a varios servicios de golpe ("Las cuatro APIs del staff"):
    // buscar ahi dejaba justamente al JWT de staff sin aparecer en ninguna API.
    const channels = CHANNELS.filter((c) => c.services.includes(id));

    const flows = FLOWS.filter((f) => f.actors.includes(id));

    const store = topo?.datastore
      ? DATASTORES.find((d) => d.id === topo.datastore)
      : null;

    return {
      service: base,
      tech,
      datastore: store ?? null,
      channels,
      flows: flows.map((f) => ({ id: f.id, label: f.label, question: f.question })),
    };
  },

  /** Los recorridos punta a punta, con los actores resueltos a etiquetas. */
  flows() {
    const data: (Flow & { actorLabels: string[] })[] = FLOWS.map((f) => ({
      ...f,
      actorLabels: f.actors
        .map((id) => SERVICES_BY_ID.get(id)?.label)
        .filter((l): l is string => Boolean(l)),
    }));
    return { data, total: data.length };
  },

  /** Los cables y las bases: como se conectan las piezas entre si. */
  integrations(): {
    channels: Channel[];
    datastores: (Datastore & {
      writerLabels: string[];
      readerLabels: string[];
    })[];
  } {
    const label = (id: string) => SERVICES_BY_ID.get(id)?.label ?? id;
    return {
      channels: CHANNELS,
      datastores: DATASTORES.map((d) => ({
        ...d,
        writerLabels: d.writers.map(label),
        readerLabels: d.readers.map(label),
      })),
    };
  },
};

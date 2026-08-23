/**
 * Catálogo de hubs y apps del PMS, espejo de `pms-core/api/src/constants/`
 * (`OS_APP_IDS` + `INDUCTION_HUBS`).
 *
 * Se replica acá a propósito: internal-laupser no importa código del PMS, y
 * las métricas necesitan agrupar por hub sin depender de que el PMS exponga un
 * endpoint. Si el catálogo del PMS cambia, hay que actualizar esta copia — el
 * script `verify:app-catalog` lo chequea.
 *
 * `social-hub` está incluido aunque la inducción lo excluya: sigue siendo una
 * app real que se puede activar y usar, y para métricas eso es lo que cuenta.
 */

export interface HubDef {
  key: string;
  label: string;
  apps: string[];
}

export const HUBS: HubDef[] = [
  {
    key: "reservas",
    label: "Reservas",
    apps: [
      "panel-reservas",
      "todas-reservas",
      "carga-manual",
      "tarifas",
      "disponibilidad",
      "promociones",
      "configuracion",
    ],
  },
  {
    key: "habitaciones",
    label: "Habitaciones",
    apps: ["estado-habitaciones", "plano-ocupacion", "gestion-categorias"],
  },
  {
    key: "marketing",
    label: "Marketing",
    apps: [
      "sitios",
      "builder",
      "marca",
      "galerias",
      "resenas",
      "linkhub",
      "social-hub",
      "libreria-archivos",
    ],
  },
  { key: "informes", label: "Informes", apps: ["informes"] },
  { key: "revenue", label: "Revenue (RMS)", apps: ["revenue"] },
  { key: "propiedades", label: "Propiedades", apps: ["propiedades"] },
];

/** Superficies que no son apps del catálogo pero sí productos medibles. */
export const EXTRA_SURFACES: HubDef[] = [
  {
    key: "motor",
    label: "Motor de reservas",
    // El huésped no "abre apps": son superficies públicas. Se miden con sus
    // propios embudos, no con app_opened.
    apps: ["motor-publico", "sitio-publico", "linkhub-publico", "staypass"],
  },
  { key: "ia", label: "Bookfer IA", apps: ["bookfer-ia"] },
];

export const ALL_HUBS = [...HUBS, ...EXTRA_SURFACES];

export const APP_IDS = ALL_HUBS.flatMap((h) => h.apps);

const HUB_BY_APP = new Map<string, string>();
for (const h of ALL_HUBS) for (const a of h.apps) HUB_BY_APP.set(a, h.key);

export function hubOf(appId: string): string | null {
  return HUB_BY_APP.get(appId) ?? null;
}

export function labelOfHub(hubKey: string): string {
  return ALL_HUBS.find((h) => h.key === hubKey)?.label ?? hubKey;
}

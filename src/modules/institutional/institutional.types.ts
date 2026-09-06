// Tipos del hub de factores educativos y migratorios internos (§15).
//
// Mide ANCLAS, no viajeros: no hay estadistica abierta de turismo medico ni de
// mudanzas corporativas, pero si se puede censar la infraestructura que genera
// esa demanda. Una universidad grande produce graduaciones todos los anios; un
// hospital de alta complejidad, acompaniantes todos los dias.

import type { AcademicWindow } from "./academic";

export type { AcademicWindow };

export type AnchorGroup = "university" | "hospital" | "worship" | "wellness" | "funeral";

export interface Anchor {
  group: AnchorGroup;
  name: string | null;
  distanceM: number;
  /** Religion del sitio o especialidad del centro de salud, si esta etiquetada. */
  detail: string | null;
}

export interface InstitutionalCoverage {
  census: boolean;
  academic: boolean;
  migration: boolean;
  gaps: string[];
}

export interface InstitutionalPointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  country: string;
  groups: Array<{
    group: AnchorGroup;
    label: string;
    /** Por que ese ancla genera demanda hotelera. */
    why: string;
    count: number;
    nearest: Anchor | null;
  }>;
  totalAnchors: number;
  dominant: string | null;
  /** Ventana academica: cuando caen las graduaciones. */
  academic: AcademicWindow | null;
  /** Migracion neta del pais (personas). Positivo = entran mas de las que salen. */
  netMigration: { value: number; year: number } | null;
  coverage: InstitutionalCoverage;
  sources: string[];
  timestamp: string;
}

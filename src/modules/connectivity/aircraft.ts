// Tabla de asientos por tipo de aeronave (event-list.md §7).
//
// El feed ADS-B da el designador OACI del modelo (A320, B738, E190...), no la
// capacidad. Sin capacidad no hay forma de contestar "volumen de asientos",
// que es el primer item de la categoria y el que fija el techo fisico de
// cuantos turistas pueden llegar en avion.
//
// Los valores son configuraciones tipicas de dos clases. Un mismo modelo varia
// entre aerolineas (un A320 va de 150 a 186 segun densidad), asi que esto
// estima un orden de magnitud, no un numero exacto. Se usa para comparar
// plazas entre si, no para vender asientos.

export const SEATS: Record<string, number> = {
  // ── Narrowbody Airbus ──
  A318: 110, A319: 140, A320: 165, A321: 200,
  A19N: 140, A20N: 175, A21N: 220,
  // ── Widebody Airbus ──
  A306: 250, A310: 220, A332: 260, A333: 290, A338: 260, A339: 290,
  A342: 260, A343: 280, A345: 300, A346: 330,
  A359: 315, A35K: 360, A388: 500,
  // ── Narrowbody Boeing ──
  B712: 100, B722: 130, B732: 130, B733: 140, B734: 150, B735: 120,
  B736: 110, B737: 140, B738: 175, B739: 190,
  B37M: 150, B38M: 175, B39M: 195, B3XM: 210,
  B752: 200, B753: 240,
  // ── Widebody Boeing ──
  B762: 220, B763: 250, B764: 290,
  B772: 310, B77L: 310, B77W: 350, B778: 350, B779: 400,
  B788: 240, B789: 290, B78X: 330,
  B741: 400, B742: 400, B744: 420, B748: 410,
  // ── Regionales ──
  E170: 76, E175: 82, E190: 100, E195: 120,
  E75L: 82, E75S: 76, E290: 100, E295: 130,
  CRJ1: 50, CRJ2: 50, CRJ7: 70, CRJ9: 90, CRJX: 100,
  BCS1: 110, BCS3: 145,
  // ── Turbohelices ──
  AT43: 48, AT45: 48, AT46: 48, AT72: 70, AT75: 70, AT76: 72,
  DH8A: 37, DH8B: 37, DH8C: 50, DH8D: 78,
  SF34: 34, SW4: 19, JS32: 19, E120: 30, F50: 50, F70: 70, F100: 100,
  // ── Legacy ──
  MD82: 150, MD83: 150, MD87: 130, MD88: 150, MD90: 160,
  B462: 82, B463: 100, RJ85: 95, RJ1H: 100,
};

/**
 * Aerolineas de carga. Un A332 de TAMPA Cargo no lleva un solo pasajero, y
 * contarlo como 260 asientos inflaria el volumen justo en los aeropuertos con
 * mas carga. Se detecta por el nombre que devuelve adsbdb y por prefijos de
 * callsign conocidos.
 */
const CARGO_NAME_RE =
  /\b(cargo|freight|logistic|express|courier|fedex|ups|dhl|atlas air|kalitta|amerijet|cargolux|abx|air transport intl)\b/i;

const CARGO_CALLSIGN_PREFIXES = new Set([
  "FDX", "UPS", "GTI", "CLX", "ABX", "ATI", "CKS", "MPH", "TPA", "LAN", "QTR",
  "GEC", "BOX", "SQC", "CAO", "CKK", "ABW", "AHK", "RCF", "NCA", "ACX", "JOS",
]);

/**
 * true si la aeronave no lleva pasajeros. `LAN` y `QTR` aparecen en la lista
 * porque sus filiales de carga comparten prefijo; el nombre de la aerolinea
 * manda cuando esta disponible, y solo se cae al prefijo si no lo esta.
 */
export function isCargo(callsign: string, airlineName: string | null): boolean {
  if (airlineName) return CARGO_NAME_RE.test(airlineName);
  const prefix = callsign.slice(0, 3).toUpperCase();
  return CARGO_CALLSIGN_PREFIXES.has(prefix);
}

/**
 * Asientos del tipo, o null si no esta en la tabla. null no es cero: se cuenta
 * aparte como "sin estimar" para que el total no mienta por lo bajo.
 */
export function seatsFor(model: string | null | undefined): number | null {
  if (!model) return null;
  return SEATS[model.toUpperCase().trim()] ?? null;
}

/**
 * Tipos que no son de transporte comercial de pasajeros: privados, militares y
 * helicopteros no aportan asientos turisticos aunque vuelen sobre la ciudad.
 */
const NON_COMMERCIAL = new Set([
  "C172", "C152", "C182", "C206", "C208", "P28A", "PA31", "BE20", "B350",
  "C25A", "C25B", "C25C", "C56X", "C68A", "CL30", "CL35", "CL60", "E55P",
  "E50P", "GLF4", "GLF5", "GLF6", "GL5T", "GL7T", "F2TH", "FA7X", "FA8X",
  "H25B", "LJ35", "LJ45", "LJ60", "PC12", "PC24", "TBM7", "TBM9", "SR22",
  "EC35", "EC45", "AS50", "A109", "B06", "B407", "B429", "R44", "R66", "S76",
]);

export const isCommercialType = (model: string | null | undefined): boolean =>
  Boolean(model) && !NON_COMMERCIAL.has((model as string).toUpperCase().trim());

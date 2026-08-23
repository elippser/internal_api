// Máscara de tierra global para validar coordenadas generadas (jitter de
// eventos sin geo propia): evita dibujar señales en el mar en mercados
// costeros (Buenos Aires, Punta Arenas, Singapur…).
//
// land.mask.json se genera desde Natural Earth 10m land (dominio público):
// simplificación Douglas-Peucker ~800 m + redondeo a 3 decimales, sin
// Antártida ni islotes menores. Cada entrada es [bbox, anillo] con
// bbox = [minLng, minLat, maxLng, maxLat] y anillo = [[lng, lat], ...].
// La fidelidad (~1 km) alcanza para el jitter de kilómetros; no usar para
// validar coordenadas de venues reales (un muelle legítimo daría "agua").

import rawRings from "./land.mask.json";

type LandRing = [[number, number, number, number], Array<[number, number]>];

const RINGS = rawRings as unknown as LandRing[];

function inRing(lng: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function isOnLand(lng: number, lat: number): boolean {
  for (const [bbox, ring] of RINGS) {
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
    if (inRing(lng, lat, ring)) return true;
  }
  return false;
}

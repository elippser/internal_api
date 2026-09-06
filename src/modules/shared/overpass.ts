// Cliente de Overpass compartido por los hubs de /global.
//
// Vive aparte porque Overpass falla de formas que no se parecen a un error y
// cada una costo un bug silencioso en el §7. Todo eso esta resuelto aca una
// sola vez:
//
//  1. Identificarse es requisito: Overpass pide un user-agent descriptivo.
//  2. **Reporta sus errores DENTRO de un HTTP 200**: si se le agota el tiempo
//     manda `remark` y una lista vacia. Tomarlo por "no hay nada" es como
//     decir que Madrid no tiene subte.
//  3. Algunos espejos devuelven 200 con lista vacia y SIN `remark`. Por eso
//     una respuesta vacia no corta el failover: se guarda y se sigue
//     probando, y solo se acepta el vacio si ninguna instancia trajo algo.
//  4. Las instancias se caen seguido (504 por sobrecarga, 502, certificados
//     vencidos), asi que se rota entre varias.
//
// Devuelve null cuando NINGUNA instancia contesto. null y [] significan cosas
// distintas y quien llama tiene que distinguirlas: null es "no se relevo", []
// es "se relevo y no hay nada".

/**
 * Instancias con la base del PLANETA. La cobertura hay que verificarla antes
 * de sumar una: `overpass.osm.ch` estuvo un rato en esta lista y resulto ser
 * un extracto **solo de Suiza**. Contestaba 200 con cero elementos en un
 * segundo para cualquier punto del resto del mundo — mas rapido que las
 * instancias buenas, asi que ganaba el failover y devolvia vacio en silencio.
 * Rochester se quedaba sin la Mayo Clinic y Lujan de Cuyo sin vinias.
 *
 * Un espejo que responde rapido y vacio es peor que un espejo caido: el caido
 * se nota.
 */
const HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const UA = "roombir-internal-global-hubs/1.0 (+https://roombir.com)";

export interface OverpassElement {
  type: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  /** Solo si la consulta pidio `out meta`. */
  timestamp?: string;
  version?: number;
}

async function onePass(query: string, timeoutMs: number): Promise<OverpassElement[] | null> {
  let emptyFallback: OverpassElement[] | null = null;

  for (const host of HOSTS) {
    try {
      const res = await fetch(host, {
        method: "POST",
        headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
      if (data.remark) continue;
      if (!Array.isArray(data.elements)) continue;
      if (data.elements.length > 0) return data.elements;
      emptyFallback = data.elements;
    } catch {
      // Se prueba la siguiente instancia.
    }
  }
  return emptyFallback;
}

/**
 * Consulta con failover y un segundo intento ante el vacio.
 *
 * El vacio transitorio es el modo de falla mas caro de Overpass porque no se
 * parece a un error: Lujan de Cuyo devolvio 0 viniedos y a los segundos, 300.
 * Un vacio legitimo (el oceano) sigue siendo vacio en los dos pases, asi que
 * repetir una vez separa un caso del otro sin inventar nada. Cuesta una
 * request extra solo cuando el resultado ya era sospechoso.
 */
export async function overpass(
  query: string,
  timeoutMs = 60_000,
): Promise<OverpassElement[] | null> {
  const first = await onePass(query, timeoutMs);
  if (first !== null && first.length > 0) return first;

  // Se reintenta SOLO ante un vacio sospechoso (alguien contesto y dijo que no
  // hay nada), no cuando no contesto nadie. Con las instancias caidas, un
  // segundo pase solo duplica la espera —de ~130 s a ~260 s— sin ninguna
  // chance de traer datos, y deja al panel colgado el doble de tiempo.
  if (first === null) return null;

  const second = await onePass(query, timeoutMs);
  if (second !== null && second.length > 0) return second;
  return second ?? first;
}

/** Posicion de un elemento, sea nodo (lat/lon) o via/relacion (center). */
export function positionOf(e: OverpassElement): { lat: number; lon: number } | null {
  if (e.center) return e.center;
  if (e.lat !== undefined && e.lon !== undefined) return { lat: e.lat, lon: e.lon };
  return null;
}

/** Clausula `(around:radio,lat,lng)` reutilizable. */
export const around = (radiusM: number, lat: number, lng: number): string =>
  "(around:" + Math.round(radiusM) + "," + lat.toFixed(4) + "," + lng.toFixed(4) + ")";

/**
 * Límite de concurrencia (y separación mínima entre arranques) por fuente.
 *
 * Los hubs no tienen deduplicación de vuelos en curso y sus fuentes tienen
 * techos duros: Nominatim 1 req/s, Open-Meteo por minuto, Overpass se cae
 * solo. Un barrido de muchas propiedades a la vez rompe cuotas si cada una
 * dispara sus hubs en paralelo. Esto los pone en fila.
 */
export function createLimiter(concurrency: number, minGapMs = 0) {
  let active = 0;
  let lastStart = 0;
  let timer: NodeJS.Timeout | null = null;
  const queue: Array<() => void> = [];

  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      const wait = lastStart + minGapMs - Date.now();
      if (wait > 0) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            pump();
          }, wait);
        }
        return;
      }
      active++;
      lastStart = Date.now();
      (queue.shift() as () => void)();
    }
  };

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}

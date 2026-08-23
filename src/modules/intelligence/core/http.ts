// Helper HTTP común de los connectors: timeout, backoff exponencial ante
// 429/5xx y errores tipados para que la ingesta pueda loggear por connector.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} en ${url}`);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number; // reintentos ante 429/5xx/red
  method?: "GET" | "POST";
  body?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchJsonOptions = {},
): Promise<T> {
  const { headers = {}, timeoutMs = 20_000, retries = 2, method = "GET", body } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url);
        if (attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchText(
  url: string,
  opts: Omit<FetchJsonOptions, "body" | "method"> = {},
): Promise<string> {
  const { headers = {}, timeoutMs = 20_000, retries = 1 } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
          ...headers,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

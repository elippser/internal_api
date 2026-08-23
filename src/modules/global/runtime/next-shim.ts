/**
 * Shim de `next/server` para correr los route handlers de elippser-gl
 * dentro de Express sin tocar su codigo.
 *
 * Los 59 handlers portados solo usan:
 *   - NextResponse.json(data, init)
 *   - new NextResponse(body, init)
 *   - request.url / request.nextUrl / request.headers / request.json() / request.text()
 *
 * Por eso alcanza con una `Response` real de undici (Node 18+) y un objeto
 * request liviano. Devolver `Response` nativa nos deja soportar streaming
 * (SSE) y binarios (tiles, proxy de CCTV) sin casos especiales.
 */

export class NextResponse extends Response {
  static json(data: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new NextResponse(JSON.stringify(data), { ...init, headers });
  }
}

/**
 * Request minimo compatible con lo que consumen los handlers.
 * No usamos `new Request()` de undici a proposito: rechaza headers
 * hop-by-hop (host, connection, content-length) que Express siempre manda.
 */
export class NextRequest {
  readonly url: string;
  readonly nextUrl: URL;
  readonly method: string;
  readonly headers: Headers;

  private readonly rawBody: string | undefined;

  constructor(
    url: URL,
    init: { method: string; headers: Headers; body?: string },
  ) {
    this.nextUrl = url;
    this.url = url.toString();
    this.method = init.method;
    this.headers = init.headers;
    this.rawBody = init.body;
  }

  async json<T = unknown>(): Promise<T> {
    if (this.rawBody === undefined) {
      throw new Error("Request sin body");
    }
    return JSON.parse(this.rawBody) as T;
  }

  async text(): Promise<string> {
    return this.rawBody ?? "";
  }
}

/**
 * Los handlers portados tipan su parametro como `Request` (el global de
 * undici) o como `NextRequest`. Recibimos un `NextRequest`, que es
 * estructuralmente compatible con lo que usan pero no con la clase entera,
 * asi que el adapter acepta cualquier firma de un solo argumento.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (request: any) => Response | Promise<Response>;

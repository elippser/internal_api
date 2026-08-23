/**
 * Alertas por webhook (spec v2 §12): POST generico (Slack/Discord/Make) con el
 * evento material. Fire-and-forget con timeout; sin reintentos: el fallo se
 * loguea en la corrida.
 */

export interface WebhookPayload {
  type: "competitor_event";
  competitor: { competitorId: string; name: string; priority: string };
  event: { kind: string; severity: string; title: string; summary: string; sourceUrl: string; observedAt: Date | string };
  link: string;
}

export async function postWebhook(url: string, payload: WebhookPayload): Promise<{ ok: boolean; error?: string }> {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: "webhook_url_invalid" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5_000);
  try {
    // Slack/Discord aceptan { text } / { content }: se mandan ambos junto con el payload crudo.
    const text = `[${payload.event.severity}] ${payload.competitor.name} · ${payload.event.kind}: ${payload.event.title}\n${payload.event.summary}\n${payload.event.sourceUrl}\n${payload.link}`;
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, text, content: text.slice(0, 1_900) }),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true };
  } catch (err) {
    const e = err as Error & { name?: string };
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : e?.message ?? "failed" };
  } finally {
    clearTimeout(t);
  }
}

export function panelLink(competitorId: string): string {
  const base = (process.env.WEB_URL ?? "http://localhost:8500").replace(/\/+$/, "");
  return `${base}/competitors/${competitorId}`;
}

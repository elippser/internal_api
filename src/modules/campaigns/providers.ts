/**
 * Abstraccion de proveedores de envio.
 *
 * Hoy bookfer no tiene ni cuenta de Resend propia ni WABA, asi que el driver
 * por defecto es `noop`: registra el envio y lo marca como mandado sin salir a
 * la red. Eso permite construir y probar templates, segmentos, cola,
 * idempotencia y reportes enteros, y que enchufar el proveedor real despues sea
 * cambiar una variable de entorno, no un refactor.
 */

export interface SendInput {
  to: string;
  subject?: string;
  body: string;
  templateName?: string;
}

export interface SendResult {
  providerMessageId: string;
  provider: string;
}

export interface MessageProvider {
  readonly name: string;
  readonly channel: "email" | "whatsapp";
  send(input: SendInput): Promise<SendResult>;
}

// ---------------------------------------------------------------------------
// noop — el default
// ---------------------------------------------------------------------------

class NoopProvider implements MessageProvider {
  constructor(
    readonly channel: "email" | "whatsapp",
    readonly name = "noop",
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    console.log(
      `[mkt:${this.channel}:noop] -> ${input.to} :: ${input.subject ?? input.templateName ?? "(sin asunto)"}`,
    );
    return {
      providerMessageId: `noop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: "noop",
    };
  }
}

// ---------------------------------------------------------------------------
// Resend — email real
// ---------------------------------------------------------------------------

class ResendProvider implements MessageProvider {
  readonly name = "resend";
  readonly channel = "email" as const;

  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject ?? "",
        html: input.body,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`resend ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { id?: string };
    return { providerMessageId: json.id ?? "unknown", provider: "resend" };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Cloud API
// ---------------------------------------------------------------------------

class WhatsAppCloudProvider implements MessageProvider {
  readonly name = "whatsapp_cloud";
  readonly channel = "whatsapp" as const;

  constructor(
    private token: string,
    private phoneNumberId: string,
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    // Fuera de la ventana de 24hs Meta rechaza el texto libre; por eso cuando
    // hay templateName se manda como template y no como texto.
    const payload = input.templateName
      ? {
          messaging_product: "whatsapp",
          to: input.to,
          type: "template",
          template: {
            name: input.templateName,
            language: { code: "es" },
          },
        }
      : {
          messaging_product: "whatsapp",
          to: input.to,
          type: "text",
          text: { body: input.body },
        };

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`whatsapp ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    return {
      providerMessageId: json.messages?.[0]?.id ?? "unknown",
      provider: "whatsapp_cloud",
    };
  }
}

// ---------------------------------------------------------------------------

let emailProvider: MessageProvider | null = null;
let whatsappProvider: MessageProvider | null = null;

export function getEmailProvider(): MessageProvider {
  if (emailProvider) return emailProvider;
  const key = process.env.MKT_RESEND_API_KEY?.trim();
  const from = process.env.MKT_EMAIL_FROM?.trim();
  emailProvider =
    key && from ? new ResendProvider(key, from) : new NoopProvider("email");
  console.log(`[mkt] proveedor de email: ${emailProvider.name}`);
  return emailProvider;
}

export function getWhatsAppProvider(): MessageProvider {
  if (whatsappProvider) return whatsappProvider;
  const token = process.env.MKT_WA_TOKEN?.trim();
  const phoneId = process.env.MKT_WA_PHONE_NUMBER_ID?.trim();
  whatsappProvider =
    token && phoneId
      ? new WhatsAppCloudProvider(token, phoneId)
      : new NoopProvider("whatsapp");
  console.log(`[mkt] proveedor de whatsapp: ${whatsappProvider.name}`);
  return whatsappProvider;
}

export function getProvider(channel: "email" | "whatsapp"): MessageProvider {
  return channel === "email" ? getEmailProvider() : getWhatsAppProvider();
}

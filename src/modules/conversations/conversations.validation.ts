import Joi from "joi";

export const createSessionSchema = Joi.object({
  agentId: Joi.string().required(),
  context: Joi.object({
    userId: Joi.string().optional(),
    companyId: Joi.string().optional(),
    propertyId: Joi.string().optional(),
    operativeSpaceId: Joi.string().allow(null, "").optional(),
    operativeSpaceName: Joi.string().allow(null, "").optional(),
    userRole: Joi.string().optional(),
    channel: Joi.string()
      .valid("pms_app", "public_web", "widget", "internal")
      .required(),
    // JWT del hotelero reenviado por el widget del PMS. Si esta presente
    // se verifica contra SHARED_JWT_SECRET / JWT_SECRET en enrichContext
    // y el userId verificado pisa al raw.
    token: Joi.string().optional(),
  }).required(),
});

// Lo que el navegador extrajo de un video o un audio: fotogramas JPEG y la
// pista de sonido en WAV (ver services/mediaDigest.service.ts).
const attachmentMediaSchema = Joi.object({
  durationSec: Joi.number().min(0).max(86_400).allow(null),
  frames: Joi.array()
    .items(
      Joi.object({
        atSec: Joi.number().min(0).max(86_400).required(),
        jpegB64: Joi.string().max(800_000).required(),
      }),
    )
    .max(16)
    .default([]),
  audioWavB64: Joi.string().allow("").max(4_500_000),
  audioSeconds: Joi.number().min(0).max(86_400),
});

export const postMessageSchema = Joi.object({
  content: Joi.string().allow("").max(10_000).default(""),
  // Adjuntos inline en base64, hasta 5 por mensaje. Imagen, PDF y texto viajan
  // tal cual en `dataB64`; video y audio viajan ya reducidos en `media` (el
  // archivo original no entra en el pedido). Los topes son de red de seguridad:
  // el techo real es el del pedido entero (4,5 MB en Vercel) y lo controla el
  // navegador antes de mandar.
  attachments: Joi.array()
    .items(
      Joi.object({
        kind: Joi.string()
          .valid("image", "document", "video", "audio")
          .required(),
        name: Joi.string().allow("").max(255).default(""),
        mediaType: Joi.string().max(100).required(),
        dataB64: Joi.when("kind", {
          is: Joi.valid("video", "audio"),
          then: Joi.string().allow("").max(7_000_000).default(""),
          otherwise: Joi.string().max(7_000_000).required(),
        }),
        media: Joi.when("kind", {
          is: Joi.valid("video", "audio"),
          then: attachmentMediaSchema.required(),
          otherwise: Joi.forbidden(),
        }),
      }),
    )
    .max(5)
    .default([]),
})
  .or("content", "attachments")
  .custom((value) => {
    if (!String(value.content).trim() && value.attachments.length === 0) {
      throw new Error("Falta content o attachments");
    }
    return value;
  });

export const actionSchema = Joi.object({
  toolName: Joi.string().min(1).max(80).required(),
  args: Joi.object().default({}),
  // Confirmación dura: la tarjeta devuelve el `confirmationId` que emitió el
  // runner al frenar un borrado o una acción irreversible, y `confirmText` con
  // lo que el usuario escribió cuando había que re-escribir el nombre del
  // recurso. Sin confirmationId, `executeAction` sólo acepta las tools de las
  // cards accionables de siempre (ACTIONABLE_TOOLS).
  confirmationId: Joi.string().max(120).optional(),
  confirmText: Joi.string().max(400).allow("").optional(),
});

export const rateMessageSchema = Joi.object({
  // `null` = quitar el voto. Antes sólo se aceptaba up/down, así que el toggle
  // de la UI limpiaba el pulgar en pantalla pero el servidor conservaba el voto
  // viejo: al recargar reaparecía, y la métrica quedaba con un voto que el
  // usuario ya había retirado.
  rating: Joi.string().valid("up", "down").allow(null).required(),
  comment: Joi.string().allow("").max(2000).optional(),
  userId: Joi.string().allow("").optional(),
});

export const listConversationsSchema = Joi.object({
  agentId: Joi.string().optional(),
  status: Joi.string().valid("active", "ended", "expired").optional(),
  channel: Joi.string()
    .valid("pms_app", "public_web", "widget", "internal")
    .optional(),
  companyId: Joi.string().optional(),
  propertyId: Joi.string().optional(),
  operativeSpaceId: Joi.string().optional(),
  // Dueño de la conversación. En el runtime del PMS lo fuerza requirePmsUser
  // con el userId del token verificado (nunca lo elige el cliente); en el
  // audit queda libre para que soporte pueda filtrar.
  userId: Joi.string().optional(),
  hasFeedback: Joi.boolean().truthy("true").falsy("false").optional(),
  dateFrom: Joi.string().isoDate().optional(),
  dateTo: Joi.string().isoDate().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

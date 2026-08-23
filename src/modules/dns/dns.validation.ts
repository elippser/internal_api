import Joi from "joi";

/**
 * Tipos que el panel deja crear. Son los que la zona de bookfer necesita
 * (plataforma + Resend). Un registro de otro tipo que ya exista en Cloudflare
 * se lista y se puede editar o borrar igual: lo que se acota es el alta.
 */
export const CREATABLE_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;

/**
 * 1 = automatico (y es obligatorio cuando el registro esta proxiado: el edge
 * decide el TTL). El resto del rango es el que acepta Cloudflare.
 */
const ttl = Joi.alternatives()
  .try(Joi.number().valid(1), Joi.number().integer().min(60).max(86400))
  .messages({
    "alternatives.match": "TTL: 1 (automatico) o entre 60 y 86400 segundos",
  });

// DKIM y algunos TXT de verificacion pasan los 400 caracteres, por eso 2048.
const content = Joi.string().trim().min(1).max(2048);

export const createRecordSchema = Joi.object({
  type: Joi.string()
    .uppercase()
    .valid(...CREATABLE_TYPES)
    .required(),
  // Se acepta corto (`app`), `@` para el apex, o el FQDN entero: el servicio
  // normaliza. `*` va permitido por el wildcard de previews.
  name: Joi.string().trim().max(255).allow("").required(),
  content: content.required(),
  ttl: ttl.default(1),
  proxied: Joi.boolean().default(false),
  priority: Joi.number().min(0).max(65535),
  comment: Joi.string().trim().max(200).allow(""),
  /**
   * Saltea los guardarrailes del inventario. No es un flag de conveniencia:
   * queda marcado en la bitacora como `forced` con el motivo que se salteo.
   */
  force: Joi.boolean().default(false),
});

export const updateRecordSchema = Joi.object({
  content,
  ttl,
  proxied: Joi.boolean(),
  priority: Joi.number().min(0).max(65535),
  comment: Joi.string().trim().max(200).allow(""),
  force: Joi.boolean().default(false),
})
  .min(1)
  .messages({ "object.min": "No hay nada que cambiar" });

export const listRecordsSchema = Joi.object({
  type: Joi.string().uppercase().max(10).allow(""),
  q: Joi.string().trim().max(200).allow(""),
});

export const removeRecordSchema = Joi.object({
  force: Joi.boolean().default(false),
});

export const changelogSchema = Joi.object({
  limit: Joi.number().min(1).max(200).default(50),
});

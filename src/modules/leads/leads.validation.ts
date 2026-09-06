import Joi from "joi";

import { LEAD_LODGING_TYPES, LEAD_STATUSES } from "./leads.model";

/**
 * Validacion del modulo.
 *
 * El schema publico es deliberadamente ESTRICTO: cada campo tiene tope de
 * largo, la lista de tipos es cerrada y las claves desconocidas se descartan
 * (`stripUnknown`). Un formulario publico que acepta cualquier cosa termina
 * guardando el payload de otro y sirviendo de almacen gratis.
 *
 * Los topes tambien son defensa: sin `max` en cada string, un POST de 10 MB por
 * campo entra igual que uno normal y el limite del body del API es global.
 */

const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

/**
 * Las UTM: cualquier clave que empiece con `utm_`, hasta 200 caracteres.
 * `unknown(false)` de por si rechazaria todo, asi que se declara el patron.
 */
const utm = Joi.object()
  .pattern(/^utm_[a-z_]{1,30}$/, Joi.string().allow("").max(200))
  .max(10)
  .default({});

export const captureLeadSchema = Joi.object({
  // ---- El alojamiento ----
  hotelName: Joi.string().trim().min(2).max(160).required().messages({
    "string.empty": "Falta el nombre del alojamiento",
    "string.min": "El nombre del alojamiento es demasiado corto",
  }),
  lodgingType: Joi.string()
    .valid(...LEAD_LODGING_TYPES)
    .required(),
  units: Joi.number().integer().min(1).max(100000).required().messages({
    "number.base": "Indica cuantas habitaciones o unidades tenes",
  }),
  countryCode: Joi.string().trim().uppercase().length(2).required(),
  city: Joi.string().trim().min(2).max(120).required(),

  // ---- Quien escribe ----
  contactName: Joi.string().trim().min(2).max(120).required(),
  /**
   * `tlds: { allow: false }` a proposito.
   *
   * Por defecto Joi valida el TLD contra la lista de IANA que trae empaquetada
   * `@sideway/address`, y esa lista envejece con la dependencia: un gTLD nuevo
   * —o un dominio interno— se rechaza con "must be a valid email" y la persona
   * se queda sin poder darse de alta por un archivo desactualizado. En la unica
   * puerta de entrada de la plataforma eso no se paga.
   *
   * Lo que valida igual es la FORMA, que es lo que evita basura en la base. Que
   * la direccion exista de verdad lo prueba el paso siguiente y sin ambiguedad:
   * si el dominio no resuelve, el correo con el acceso no llega y no hay cuenta.
   */
  email: Joi.string()
    .trim()
    .lowercase()
    .email({ minDomainSegments: 2, tlds: { allow: false } })
    .max(254)
    .required(),
  phone: Joi.string().trim().allow("").max(32).default(""),

  // ---- Contexto ----
  locale: Joi.string().valid("es", "en", "pt", "fr", "de").default("es"),
  siteId: Joi.string().allow("").max(80).default(""),
  utm,
  referer: Joi.string().allow("").max(500).default(""),

  // ---- Senales del filtro (las manda el formulario, no la persona) ----
  /** Campo trampa. Un humano no lo ve; un bot lo completa. */
  website: Joi.string().allow("").max(200).default(""),
  /** Milisegundos entre el render y el submit. */
  elapsedMs: Joi.number().integer().min(0).max(86_400_000).allow(null).default(null),
  /**
   * Sin default a proposito: `undefined` significa "no lo sabemos" (un cliente
   * viejo, un navegador raro) y el filtro no lo castiga; `false` significa "no
   * hubo interaccion", que si suma sospecha. Joi ademas rechaza un
   * `.default(undefined)` explicito con "Missing default value".
   */
  interacted: Joi.boolean().optional(),
  /** Token de Turnstile, si el sitio lo tiene activado. */
  captchaToken: Joi.string().allow("").max(4000).default(""),
});

export const listLeadsSchema = Joi.object({
  status: Joi.string()
    .valid(...LEAD_STATUSES)
    .optional(),
  lodgingType: Joi.string()
    .valid(...LEAD_LODGING_TYPES)
    .optional(),
  country: Joi.string().trim().uppercase().length(2).optional(),
  search: Joi.string().trim().allow("").max(120).optional(),
  sort: Joi.string().valid("recent", "units", "name").default("recent"),
  ...pagination,
});

export const updateLeadSchema = Joi.object({
  status: Joi.string()
    .valid(...LEAD_STATUSES)
    .optional(),
  notes: Joi.string().allow("").max(4000).optional(),
  ownerUserId: Joi.string().allow("", null).max(80).optional(),
}).min(1);

export const statsSchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(30),
});

// ---------------------------------------------------------------------------
// Server-to-server (lo llama pms-core con X-Internal-Secret)
// ---------------------------------------------------------------------------

export const verifyInviteSchema = Joi.object({
  token: Joi.string().trim().min(20).max(200).required(),
});

export const consumeInviteSchema = Joi.object({
  token: Joi.string().trim().min(20).max(200).required(),
  /**
   * El correo con el que el PMS esta por crear la cuenta. Tiene que coincidir
   * con el del invite. Mismo criterio de TLD que la captura: si se rechazara
   * aca una direccion que el formulario acepto, el alta quedaria a mitad de
   * camino — usuario creado y token sin quemar.
   */
  email: Joi.string()
    .trim()
    .lowercase()
    .email({ tlds: { allow: false } })
    .max(254)
    .required(),
  userId: Joi.string().allow("", null).max(120).optional(),
  ip: Joi.string().allow("").max(60).optional(),
  userAgent: Joi.string().allow("").max(400).optional(),
});

import Joi from "joi";

/**
 * `refresh` es lo unico que puede costar plata (llamadas) en todo el modulo, y
 * por eso es explicito: sin el, todo se sirve del cache. El servicio ademas le
 * aplica un piso de tiempo, asi que mandarlo en loop no sirve de nada.
 */
export const overviewSchema = Joi.object({
  refresh: Joi.boolean().truthy("1").falsy("0").default(false),
});

export const detailSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(20).default(10),
});

export const activitySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(30),
  refresh: Joi.boolean().truthy("1").falsy("0").default(false),
});

/** Mismo `refresh` que el tablero: GitHub es mas holgado, pero se cachea igual. */
export const reposSchema = Joi.object({
  refresh: Joi.boolean().truthy("1").falsy("0").default(false),
});

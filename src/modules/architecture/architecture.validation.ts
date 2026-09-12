import Joi from "joi";
import { TECH_CATEGORIES } from "./architecture.tech";

export const stackSchema = Joi.object({
  category: Joi.string().valid(...TECH_CATEGORIES.map((c) => c.id)),
  q: Joi.string().trim().max(80).allow(""),
});

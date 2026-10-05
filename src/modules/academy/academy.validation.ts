import Joi from "joi";

import { ATTEMPT_KINDS, FRICTION_SOURCES, SUBMISSION_MODULES, TRACKS } from "./academy.model";

/** Ids de leccion: "0.1", "A.3", "E.10". */
const lessonId = Joi.string().pattern(/^[0-9A-Z]{1,2}\.?[0-9a-z]{1,2}$/).max(8);
const itemId = Joi.string().pattern(/^[a-z0-9-]{3,60}$/);
const certainty = Joi.number().integer().min(1).max(3).required();

export const lessonIdSchema = lessonId.required();

export const practiceAnswerSchema = Joi.object({
  itemId: itemId.required(),
  chosenText: Joi.string().max(600).required(),
  certainty,
  hintUsed: Joi.boolean().default(false),
});

export const preAnswerSchema = Joi.object({
  itemId: itemId.required(),
  chosenText: Joi.string().max(600).required(),
  certainty,
});

export const updateLessonSchema = Joi.object({
  explainBack: Joi.string().allow("").max(4000),
  status: Joi.string().valid("en_curso", "hecha"),
}).min(1);

export const attemptKindSchema = Joi.string()
  .valid(...ATTEMPT_KINDS)
  .required();

export const submitAttemptSchema = Joi.object({
  answers: Joi.array()
    .items(
      Joi.object({
        itemId: itemId.required(),
        chosen: Joi.number().integer().min(-1).max(2).required(),
        certainty,
        hintUsed: Joi.boolean().default(false),
      }),
    )
    .max(60)
    .required(),
});

export const submissionSchema = Joi.object({
  draft: Joi.string().allow("").max(8000),
  link: Joi.string().allow("").uri({ scheme: ["http", "https"] }).max(600),
  submit: Joi.boolean().default(false),
});

export const submissionModuleSchema = Joi.string()
  .valid(...SUBMISSION_MODULES)
  .required();

const rubricScore = Joi.number().integer().min(0).max(2).required();

export const reviewSchema = Joi.object({
  rubric: Joi.object({
    fidelidad: rubricScore,
    reglas: rubricScore,
    claridad: rubricScore,
    oficio: rubricScore,
  }).required(),
  feedback: Joi.string().allow("").max(4000).default(""),
});

export const frictionSchema = Joi.object({
  source: Joi.string()
    .valid(...FRICTION_SOURCES)
    .required(),
  screen: Joi.string().allow("").max(200).default(""),
  note: Joi.string().trim().min(2).max(2000).required(),
});

export const enrollSchema = Joi.object({
  track: Joi.string()
    .valid(...TRACKS)
    .required(),
});

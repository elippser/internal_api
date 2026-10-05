import type { Request, Response } from "express";
import type { Schema } from "joi";

import { fail, ok } from "../../shared/utils/http";
import type { AttemptKind, Track } from "./academy.model";
import { AcademyError, academyService as s } from "./academy.service";
import {
  attemptKindSchema,
  enrollSchema,
  frictionSchema,
  lessonIdSchema,
  practiceAnswerSchema,
  preAnswerSchema,
  reviewSchema,
  submissionModuleSchema,
  submissionSchema,
  submitAttemptSchema,
  updateLessonSchema,
} from "./academy.validation";

function handleErr(res: Response, err: any) {
  if (err instanceof AcademyError) return fail(res, err.status, err.message, err.code);
  if (err?.name === "CastError") return fail(res, 404, "No encontrado", "not_found");
  console.error("[academy]", err);
  return fail(res, 500, "Error interno");
}

function valid<T>(schema: Schema, value: unknown): T {
  const { error, value: out } = schema.validate(value, { stripUnknown: true, abortEarly: true });
  if (error) throw new AcademyError(400, error.message, "invalid_body");
  return out as T;
}

const uid = (req: Request) => req.internalUser!.userId;

/** Envuelve un handler async con el manejo de errores comun. */
function h(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      handleErr(res, err);
    }
  };
}

export const academyController = {
  me: h(async (req, res) => ok(res, await s.me(uid(req)))),
  enroll: h(async (req, res) => {
    const body = valid<{ track: Track }>(enrollSchema, req.body);
    ok(res, await s.enroll(uid(req), body.track));
  }),

  // ---- Lecciones ----
  lessonQuiz: h(async (req, res) => {
    const lessonId = valid<string>(lessonIdSchema, req.params.lessonId);
    ok(res, { items: s.lessonQuiz(lessonId) });
  }),
  preAnswer: h(async (req, res) => {
    const lessonId = valid<string>(lessonIdSchema, req.params.lessonId);
    const body = valid<{ itemId: string; chosenText: string; certainty: number }>(preAnswerSchema, req.body);
    ok(res, await s.savePreAnswer(uid(req), lessonId, body));
  }),
  updateLesson: h(async (req, res) => {
    const lessonId = valid<string>(lessonIdSchema, req.params.lessonId);
    const body = valid<{ explainBack?: string; status?: "en_curso" | "hecha" }>(updateLessonSchema, req.body);
    ok(res, await s.updateLesson(uid(req), lessonId, body));
  }),

  // ---- Practica y repaso ----
  answer: h(async (req, res) => {
    const body = valid<{ itemId: string; chosenText: string; certainty: number; hintUsed?: boolean }>(
      practiceAnswerSchema,
      req.body,
    );
    ok(res, await s.answerPractice(uid(req), body));
  }),
  reviewToday: h(async (req, res) => ok(res, await s.reviewToday(uid(req)))),

  // ---- Intentos ----
  startAttempt: h(async (req, res) => {
    const kind = valid<AttemptKind>(attemptKindSchema, req.params.kind);
    ok(res, await s.startAttempt(uid(req), kind));
  }),
  submitAttempt: h(async (req, res) => {
    const body = valid<{ answers: { itemId: string; chosen: number; certainty: number; hintUsed?: boolean }[] }>(
      submitAttemptSchema,
      req.body,
    );
    ok(res, await s.submitAttempt(uid(req), String(req.params.attemptId), body.answers));
  }),
  listAttempts: h(async (req, res) => ok(res, { data: await s.listAttempts(uid(req)) })),
  attemptResult: h(async (req, res) => ok(res, await s.getAttemptResult(uid(req), String(req.params.attemptId)))),

  // ---- Piezas y fricciones ----
  listSubmissions: h(async (req, res) => ok(res, { data: await s.listSubmissions(uid(req)) })),
  saveSubmission: h(async (req, res) => {
    const module = valid<string>(submissionModuleSchema, req.params.module);
    const body = valid<{ draft?: string; link?: string; submit?: boolean }>(submissionSchema, req.body);
    ok(res, await s.saveSubmission(uid(req), module, body));
  }),
  listFrictions: h(async (req, res) => ok(res, { data: await s.listFrictions(uid(req)) })),
  addFriction: h(async (req, res) => {
    const body = valid<{ source: string; screen?: string; note: string }>(frictionSchema, req.body);
    ok(res, await s.addFriction(uid(req), body), 201);
  }),

  // ---- Equipo (admin) ----
  team: h(async (_req, res) => ok(res, await s.team())),
  reviewSubmission: h(async (req, res) => {
    const body = valid<{
      rubric: { fidelidad: number; reglas: number; claridad: number; oficio: number };
      feedback: string;
    }>(reviewSchema, req.body);
    ok(res, await s.reviewSubmission(uid(req), String(req.params.id), body));
  }),
};

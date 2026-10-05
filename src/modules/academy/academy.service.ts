import { InternalUser } from "../users/users.model";
import {
  AcademyAttempt,
  AcademyCard,
  AcademyEnrollment,
  AcademyFriction,
  AcademyLessonProgress,
  AcademySubmission,
  BOX_INTERVAL_DAYS,
  type AttemptKind,
  type Track,
} from "./academy.model";
import { ATTEMPT_SIZES, BANK, BANK_BY_ID, type BankItem } from "./bank/items";

/**
 * Logica de la Academia (ROOMBIR-ACADEMY-SPEC.md §6 y §7).
 *
 * Tres principios de diseño que no se ven en el codigo:
 * - **La correcta nunca viaja antes de responder.** Practica: el cliente manda
 *   el TEXTO de la opcion elegida. Examen: manda el indice mostrado y el
 *   servidor des-permuta con el orden guardado en el intento.
 * - **Certeza en todo** (Gardner-Medwin): el puntaje CBM no decide el
 *   aprobado, pero un error seguro vuelve al repaso a las 24 h
 *   (hipercorreccion).
 * - **Repaso espaciado y mezclado**: cada item respondido se vuelve tarjeta en
 *   una caja de Leitner (1, 3, 7, 14, 30 dias).
 */

const DAY_MS = 86_400_000;
const PASS_PCT = 0.8;
const RETAKE_WAIT_MS = 48 * 3_600_000;
/** El control de retencion se habilita 30 dias despues de aprobar el examen 3. */
const RETENTION_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Un intento abierto se retoma si tiene menos de esto; despues se descarta. */
const OPEN_ATTEMPT_MS = 3 * 3_600_000;
const REVIEW_BATCH = 10;

export class AcademyError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Puntaje CBM: certeza 1..3; acierto +1/+2/+3, error 0/-2/-6. */
export function cbmScore(correct: boolean, certainty: number): number {
  const c = Math.min(3, Math.max(1, Math.round(certainty)));
  if (correct) return c;
  return c === 1 ? 0 : c === 2 ? -2 : -6;
}

/** Item sin respuesta, para mostrar. `options` en el orden dado. */
function publicItem(item: BankItem, order: number[]) {
  return {
    id: item.id,
    lesson: item.lesson,
    exam: item.exam,
    type: item.type,
    critical: item.critical,
    stem: item.stem,
    options: order.map((i) => item.options[i]),
    hint: item.hint ?? null,
  };
}

/** Correccion completa en el orden mostrado. */
function revealItem(item: BankItem, order: number[]) {
  return {
    ...publicItem(item, order),
    correctIndex: order.indexOf(item.correct),
    why: order.map((i) => item.why[i]),
    sources: item.sources,
  };
}

function itemOrThrow(itemId: string): BankItem {
  const item = BANK_BY_ID.get(itemId);
  if (!item) throw new AcademyError(404, "Item inexistente", "item_not_found");
  return item;
}

async function scheduleCard(userId: string, itemId: string, correct: boolean, certainty: number) {
  const existing = await AcademyCard.findOne({ userId, itemId }).lean();
  const prevBox = existing?.box ?? 1;
  // Acierto: sube de caja (un item nuevo acertado arranca en la 2). Error: a
  // la caja 1, mañana. Un error con certeza alta tambien vuelve mañana:
  // es el que mas conviene re-preguntar (hipercorreccion).
  const box = correct ? Math.min(5, existing ? prevBox + 1 : 2) : 1;
  const days = BOX_INTERVAL_DAYS[box - 1];
  await AcademyCard.updateOne(
    { userId, itemId },
    {
      $set: {
        box,
        dueAt: new Date(Date.now() + days * DAY_MS),
        lastResult: correct,
        lastCertainty: certainty,
      },
      $inc: { reviews: 1 },
    },
    { upsert: true },
  );
}

// ---------------------------------------------------------------------------
// Practica: preguntas de leccion y repaso diario
// ---------------------------------------------------------------------------

function practiceView(item: BankItem) {
  return publicItem(item, shuffle([0, 1, 2]));
}

export const academyService = {
  lessonQuiz(lessonId: string) {
    return BANK.filter((it) => it.lesson === lessonId).map(practiceView);
  },

  async answerPractice(
    userId: string,
    input: { itemId: string; chosenText: string; certainty: number; hintUsed?: boolean },
  ) {
    const item = itemOrThrow(input.itemId);
    const chosen = item.options.indexOf(input.chosenText as BankItem["options"][number]);
    if (chosen < 0) throw new AcademyError(400, "Opcion invalida", "invalid_option");
    const certainty = input.hintUsed ? Math.min(2, input.certainty) : input.certainty;
    const correct = chosen === item.correct;
    await scheduleCard(userId, item.id, correct, certainty);
    return {
      correct,
      cbm: cbmScore(correct, certainty),
      correctText: item.options[item.correct],
      why: item.options.map((text, i) => ({ text, why: item.why[i], correct: i === item.correct })),
      sources: item.sources,
    };
  },

  async reviewToday(userId: string) {
    const now = new Date();
    const due = await AcademyCard.find({ userId, dueAt: { $lte: now } })
      .sort({ dueAt: 1 })
      .limit(50)
      .lean();
    const total = due.length;
    // Mezclado (interleaving): no por orden de vencimiento ni por leccion.
    const batch = shuffle(due)
      .slice(0, REVIEW_BATCH)
      .map((c) => BANK_BY_ID.get(c.itemId))
      .filter((it): it is BankItem => Boolean(it))
      .map(practiceView);
    return { totalDue: total, items: batch };
  },

  // -------------------------------------------------------------------------
  // Avance por leccion
  // -------------------------------------------------------------------------

  async listProgress(userId: string) {
    return AcademyLessonProgress.find({ userId }).lean();
  },

  async savePreAnswer(
    userId: string,
    lessonId: string,
    input: { itemId: string; chosenText: string; certainty: number },
  ) {
    const item = itemOrThrow(input.itemId);
    if (item.lesson !== lessonId) throw new AcademyError(400, "El item no es de esta leccion", "item_lesson_mismatch");
    const chosen = item.options.indexOf(input.chosenText as BankItem["options"][number]);
    if (chosen < 0) throw new AcademyError(400, "Opcion invalida", "invalid_option");
    await AcademyLessonProgress.updateOne(
      { userId, lessonId },
      {
        $setOnInsert: { status: "en_curso" },
        $pull: { preAnswers: { itemId: item.id } },
      },
      { upsert: true },
    );
    await AcademyLessonProgress.updateOne(
      { userId, lessonId },
      { $push: { preAnswers: { itemId: item.id, chosen, certainty: input.certainty, at: new Date() } } },
    );
    // Sin correccion: se ve al final de la leccion (efecto pretesting).
    return { saved: true };
  },

  async updateLesson(
    userId: string,
    lessonId: string,
    input: { explainBack?: string; status?: "en_curso" | "hecha" },
  ) {
    const set: Record<string, unknown> = {};
    if (input.explainBack !== undefined) set.explainBack = input.explainBack;
    if (input.status) {
      set.status = input.status;
      if (input.status === "hecha") set.doneAt = new Date();
    }
    await AcademyLessonProgress.updateOne({ userId, lessonId }, { $set: set }, { upsert: true });
    return AcademyLessonProgress.findOne({ userId, lessonId }).lean();
  },

  // -------------------------------------------------------------------------
  // Intentos: diagnostico, examenes, retencion
  // -------------------------------------------------------------------------

  poolFor(kind: AttemptKind): BankItem[] {
    if (kind === "examen1") return BANK.filter((it) => it.exam === 1);
    if (kind === "examen2") return BANK.filter((it) => it.exam === 2);
    if (kind === "examen3") return BANK.filter((it) => it.exam === 3);
    return BANK;
  },

  async startAttempt(userId: string, kind: AttemptKind) {
    const isExam = kind.startsWith("examen");

    const open = await AcademyAttempt.findOne({
      userId,
      kind,
      submittedAt: { $exists: false },
      startedAt: { $gte: new Date(Date.now() - OPEN_ATTEMPT_MS) },
    }).lean();
    if (open) return this.attemptView(open);

    const last = await AcademyAttempt.findOne({ userId, kind, submittedAt: { $exists: true } })
      .sort({ submittedAt: -1 })
      .lean();
    if (isExam && last && last.passed === false && last.submittedAt) {
      const nextAt = new Date(new Date(last.submittedAt).getTime() + RETAKE_WAIT_MS);
      if (nextAt.getTime() > Date.now()) {
        throw new AcademyError(
          409,
          `Puedes volver a rendirlo desde ${nextAt.toISOString()}`,
          "retake_wait",
        );
      }
    }

    // Primero los items que NO salieron en el intento anterior; si el banco
    // no alcanza, se completa con los repetidos.
    const prev = new Set(last?.itemIds ?? []);
    const pool = this.poolFor(kind);
    const size = ATTEMPT_SIZES[kind];
    // En un examen entran SIEMPRE todos los criticos de su banco: se aprueba con
    // el 100% de ellos, y sorteados podian quedar afuera o no volver a salir en
    // el reintento (que prefiere lo que no salio antes).
    const must = isExam ? shuffle(pool.filter((it) => it.critical)).slice(0, size) : [];
    const mustIds = new Set(must.map((it) => it.id));
    const rest = pool.filter((it) => !mustIds.has(it.id));
    const fresh = shuffle(rest.filter((it) => !prev.has(it.id)));
    const repeated = shuffle(rest.filter((it) => prev.has(it.id)));
    const chosen = [...must, ...fresh, ...repeated].slice(0, size);
    // Los criticos al azar entre el resto, no al final.
    const items = shuffle(chosen);

    const optionOrders: Record<string, number[]> = {};
    for (const it of items) optionOrders[it.id] = shuffle([0, 1, 2]);

    const doc = await AcademyAttempt.create({
      userId,
      kind,
      itemIds: items.map((it) => it.id),
      optionOrders,
      startedAt: new Date(),
    });
    return this.attemptView(doc.toObject());
  },

  attemptView(doc: { _id: unknown; kind: string; itemIds: string[]; optionOrders: any; startedAt: Date }) {
    const items = doc.itemIds
      .map((id) => BANK_BY_ID.get(id))
      .filter((it): it is BankItem => Boolean(it))
      .map((it) => publicItem(it, doc.optionOrders?.[it.id] ?? [0, 1, 2]));
    return {
      attemptId: String(doc._id),
      kind: doc.kind,
      startedAt: doc.startedAt,
      targetSize: ATTEMPT_SIZES[doc.kind as AttemptKind],
      items,
    };
  },

  async submitAttempt(
    userId: string,
    attemptId: string,
    answers: { itemId: string; chosen: number; certainty: number; hintUsed?: boolean }[],
  ) {
    const doc = await AcademyAttempt.findOne({ _id: attemptId, userId });
    if (!doc) throw new AcademyError(404, "Intento inexistente", "attempt_not_found");
    if (doc.submittedAt) throw new AcademyError(409, "Este intento ya se entrego", "already_submitted");

    const byId = new Map(answers.map((a) => [a.itemId, a]));
    const orders = (doc.optionOrders ?? {}) as Record<string, number[]>;
    const graded = doc.itemIds.map((itemId) => {
      const item = itemOrThrow(itemId);
      const order = orders[itemId] ?? [0, 1, 2];
      const a = byId.get(itemId);
      // Sin responder = incorrecto con certeza baja (no resta, pero no suma).
      const shown = a ? a.chosen : -1;
      const chosen = shown >= 0 && shown < 3 ? order[shown] : -1;
      const certainty = a ? (a.hintUsed ? Math.min(2, a.certainty) : a.certainty) : 1;
      const correct = chosen === item.correct;
      return {
        item,
        order,
        shown,
        answer: { itemId, chosen, certainty, hintUsed: Boolean(a?.hintUsed), correct, cbm: cbmScore(correct, certainty) },
      };
    });

    const total = graded.length || 1;
    const right = graded.filter((g) => g.answer.correct).length;
    const pctCorrect = right / total;
    const cbmTotal = graded.reduce((s, g) => s + g.answer.cbm, 0);
    const criticals = graded.filter((g) => g.item.critical);
    // §6.3: 100% de criticos (lo que implica cero errores seguros en ellos).
    const criticalOk = criticals.every((g) => g.answer.correct);
    const isExam = doc.kind.startsWith("examen");
    const passed = isExam ? pctCorrect >= PASS_PCT && criticalOk : undefined;

    doc.set({
      answers: graded.map((g) => g.answer),
      pctCorrect,
      cbmTotal,
      criticalOk,
      passed,
      submittedAt: new Date(),
    });
    await doc.save();

    for (const g of graded) {
      await scheduleCard(userId, g.item.id, g.answer.correct, g.answer.certainty);
    }

    return {
      attemptId: String(doc._id),
      kind: doc.kind,
      pctCorrect,
      cbmTotal,
      cbmMax: total * 3,
      criticalOk,
      passed: passed ?? null,
      passPct: PASS_PCT,
      retakeAt: passed === false ? new Date(Date.now() + RETAKE_WAIT_MS) : null,
      items: graded.map((g) => ({
        ...revealItem(g.item, g.order),
        chosenIndex: g.shown,
        certainty: g.answer.certainty,
        correct: g.answer.correct,
        cbm: g.answer.cbm,
        /** "Mal informada": error con certeza alta. Lo que mas importa corregir. */
        misinformed: !g.answer.correct && g.answer.certainty >= 3,
      })),
    };
  },

  async listAttempts(userId: string) {
    const docs = await AcademyAttempt.find({ userId, submittedAt: { $exists: true } })
      .sort({ submittedAt: -1 })
      .limit(50)
      .lean();
    return docs.map((d) => ({
      attemptId: String(d._id),
      kind: d.kind,
      pctCorrect: d.pctCorrect,
      cbmTotal: d.cbmTotal,
      criticalOk: d.criticalOk,
      passed: d.passed ?? null,
      size: d.itemIds.length,
      submittedAt: d.submittedAt,
    }));
  },

  async getAttemptResult(userId: string, attemptId: string) {
    const d = await AcademyAttempt.findOne({ _id: attemptId, userId }).lean();
    if (!d || !d.submittedAt) throw new AcademyError(404, "Intento inexistente", "attempt_not_found");
    const orders = (d.optionOrders ?? {}) as Record<string, number[]>;
    const byId = new Map((d.answers ?? []).map((a) => [a.itemId, a]));
    return {
      attemptId: String(d._id),
      kind: d.kind,
      pctCorrect: d.pctCorrect,
      cbmTotal: d.cbmTotal,
      cbmMax: d.itemIds.length * 3,
      criticalOk: d.criticalOk,
      passed: d.passed ?? null,
      passPct: PASS_PCT,
      retakeAt:
        d.passed === false && d.submittedAt
          ? new Date(new Date(d.submittedAt).getTime() + RETAKE_WAIT_MS)
          : null,
      items: d.itemIds
        .map((id) => BANK_BY_ID.get(id))
        .filter((it): it is BankItem => Boolean(it))
        .map((it) => {
          const order = orders[it.id] ?? [0, 1, 2];
          const a = byId.get(it.id);
          const chosen = a?.chosen ?? -1;
          return {
            ...revealItem(it, order),
            chosenIndex: chosen >= 0 ? order.indexOf(chosen) : -1,
            certainty: a?.certainty ?? 1,
            correct: Boolean(a?.correct),
            cbm: a?.cbm ?? 0,
            misinformed: Boolean(a && !a.correct && (a.certainty ?? 0) >= 3),
          };
        }),
    };
  },

  // -------------------------------------------------------------------------
  // Resumen de "hoy"
  // -------------------------------------------------------------------------

  async enroll(userId: string, track: Track) {
    await AcademyEnrollment.updateOne(
      { userId },
      { $set: { track }, $setOnInsert: { startedAt: new Date() } },
      { upsert: true },
    );
    return AcademyEnrollment.findOne({ userId }).lean();
  },

  async me(userId: string) {
    const [enrollment, progress, dueCount, cards, attempts, submissions] = await Promise.all([
      AcademyEnrollment.findOne({ userId }).lean(),
      AcademyLessonProgress.find({ userId }).lean(),
      AcademyCard.countDocuments({ userId, dueAt: { $lte: new Date() } }),
      AcademyCard.countDocuments({ userId }),
      this.listAttempts(userId),
      AcademySubmission.find({ userId }).lean(),
    ]);

    const kinds: AttemptKind[] = ["diagnostico", "examen1", "examen2", "examen3", "retencion"];
    const attemptsByKind = Object.fromEntries(
      kinds.map((k) => {
        const mine = attempts.filter((a) => a.kind === k);
        const last = mine[0] ?? null;
        // Vienen del mas nuevo al mas viejo: el ultimo aprobado de la lista es la primera vez que aprobo.
        const firstPass = mine.filter((a) => a.passed === true).pop() ?? null;
        const retakeAt =
          last && last.passed === false && last.submittedAt
            ? new Date(new Date(last.submittedAt).getTime() + RETAKE_WAIT_MS)
            : null;
        return [
          k,
          {
            count: mine.length,
            passed: mine.some((a) => a.passed === true),
            passedAt: firstPass?.submittedAt ?? null,
            last,
            retakeAt: retakeAt && retakeAt.getTime() > Date.now() ? retakeAt : null,
            poolSize: this.poolFor(k).length,
            targetSize: ATTEMPT_SIZES[k],
          },
        ];
      }),
    );

    // Control de retencion: 30 dias despues de aprobar el examen 3 (spec §6).
    const exam3PassedAt = (attemptsByKind.examen3 as { passedAt: Date | string | null }).passedAt;
    const retentionDueAt = exam3PassedAt ? new Date(new Date(exam3PassedAt).getTime() + RETENTION_AFTER_MS) : null;
    const retentionDone = (attemptsByKind.retencion as { count: number }).count > 0;

    return {
      retention: {
        dueAt: retentionDueAt,
        due: Boolean(retentionDueAt && retentionDueAt.getTime() <= Date.now()),
        done: retentionDone,
      },
      track: (enrollment?.track as Track | undefined) ?? null,
      startedAt: enrollment?.startedAt ?? null,
      progress: progress.map((p) => ({
        lessonId: p.lessonId,
        status: p.status,
        explainBack: p.explainBack,
        preAnswered: (p.preAnswers ?? []).map((a) => a.itemId),
        doneAt: p.doneAt ?? null,
      })),
      review: { due: dueCount, cards },
      attempts: attemptsByKind,
      submissions: submissions.map((s) => ({ module: s.module, status: s.status })),
      passPct: PASS_PCT,
    };
  },

  // -------------------------------------------------------------------------
  // Piezas y fricciones
  // -------------------------------------------------------------------------

  async listSubmissions(userId: string) {
    return AcademySubmission.find({ userId }).sort({ module: 1 }).lean();
  },

  async saveSubmission(
    userId: string,
    module: string,
    input: { draft?: string; link?: string; submit?: boolean },
  ) {
    const current = await AcademySubmission.findOne({ userId, module }).lean();
    if (current?.status === "aprobada") {
      throw new AcademyError(409, "Esta pieza ya esta aprobada", "already_approved");
    }
    const set: Record<string, unknown> = {};
    if (input.draft !== undefined) set.draft = input.draft;
    if (input.link !== undefined) set.link = input.link;
    if (input.submit) {
      set.status = "enviada";
      set.submittedAt = new Date();
    } else if (!current) {
      set.status = "borrador";
    }
    await AcademySubmission.updateOne({ userId, module }, { $set: set }, { upsert: true });
    return AcademySubmission.findOne({ userId, module }).lean();
  },

  async reviewSubmission(
    reviewerId: string,
    submissionId: string,
    input: { rubric: { fidelidad: number; reglas: number; claridad: number; oficio: number }; feedback: string },
  ) {
    const doc = await AcademySubmission.findById(submissionId);
    if (!doc) throw new AcademyError(404, "Pieza inexistente", "submission_not_found");
    const r = input.rubric;
    const sum = r.fidelidad + r.reglas + r.claridad + r.oficio;
    // §6.4: 6/8 o mas, y ningun 0 en fidelidad ni en reglas.
    const approved = sum >= 6 && r.fidelidad > 0 && r.reglas > 0;
    doc.set({
      rubric: r,
      feedback: input.feedback,
      reviewerId,
      reviewedAt: new Date(),
      status: approved ? "aprobada" : "a_corregir",
    });
    await doc.save();
    return doc.toObject();
  },

  async listFrictions(userId: string) {
    return AcademyFriction.find({ userId }).sort({ createdAt: -1 }).limit(200).lean();
  },

  async addFriction(userId: string, input: { source: string; screen?: string; note: string }) {
    const doc = await AcademyFriction.create({ userId, ...input });
    return doc.toObject();
  },

  // -------------------------------------------------------------------------
  // Equipo (admin)
  // -------------------------------------------------------------------------

  async team() {
    const [enrollments, progress, attempts, submissions, frictions] = await Promise.all([
      AcademyEnrollment.find({}).lean(),
      AcademyLessonProgress.find({}).lean(),
      AcademyAttempt.find({ submittedAt: { $exists: true } }).sort({ submittedAt: -1 }).lean(),
      AcademySubmission.find({}).lean(),
      AcademyFriction.find({}).sort({ createdAt: -1 }).lean(),
    ]);
    const ids = new Set<string>([
      ...enrollments.map((e) => e.userId),
      ...progress.map((p) => p.userId),
      ...attempts.map((a) => a.userId),
      ...submissions.map((s) => s.userId),
      ...frictions.map((f) => f.userId),
    ]);
    const users = await InternalUser.find({ userId: { $in: [...ids] } })
      .select("userId email firstName lastName role")
      .lean();
    const userById = new Map(users.map((u) => [u.userId, u]));

    const people = [...ids].map((userId) => {
      const u = userById.get(userId);
      const mine = attempts.filter((a) => a.userId === userId);
      return {
        userId,
        name: u ? `${u.firstName} ${u.lastName}`.trim() : userId,
        email: u?.email ?? null,
        track: enrollments.find((e) => e.userId === userId)?.track ?? null,
        lessonsDone: progress.filter((p) => p.userId === userId && p.status === "hecha").length,
        lastActivity:
          [
            ...progress.filter((p) => p.userId === userId).map((p) => p.updatedAt),
            ...mine.map((a) => a.submittedAt),
          ]
            .filter(Boolean)
            .sort()
            .pop() ?? null,
        attempts: mine.map((a) => ({
          attemptId: String(a._id),
          kind: a.kind,
          pctCorrect: a.pctCorrect,
          passed: a.passed ?? null,
          submittedAt: a.submittedAt,
        })),
        explainBacks: progress
          .filter((p) => p.userId === userId && p.explainBack)
          .map((p) => ({ lessonId: p.lessonId, text: p.explainBack, at: p.updatedAt })),
        frictions: frictions
          .filter((f) => f.userId === userId)
          .map((f) => ({ source: f.source, screen: f.screen, note: f.note, at: f.createdAt })),
      };
    });

    return {
      people,
      submissions: submissions.map((s) => ({
        id: String(s._id),
        userId: s.userId,
        name: (() => {
          const u = userById.get(s.userId);
          return u ? `${u.firstName} ${u.lastName}`.trim() : s.userId;
        })(),
        module: s.module,
        status: s.status,
        draft: s.draft,
        link: s.link,
        rubric: s.rubric ?? null,
        feedback: s.feedback,
        submittedAt: s.submittedAt ?? null,
      })),
      bank: {
        total: BANK.length,
        byExam: [1, 2, 3].map((n) => ({ exam: n, items: BANK.filter((it) => it.exam === n).length })),
      },
    };
  },
};

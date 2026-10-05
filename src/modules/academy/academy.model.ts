import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Academia interna (ROOMBIR-ACADEMY-SPEC.md §7.3).
 *
 * El CONTENIDO (lecciones, glosario) vive en el repo del front y el banco de
 * items en `bank/items.ts`: se versionan con git. Aca solo vive lo que hace
 * cada persona: avance, tarjetas de repaso, intentos de examen, piezas y
 * fricciones. Todo se indexa por `userId` del padron interno.
 */

// ---------------------------------------------------------------------------
// Avance por leccion
// ---------------------------------------------------------------------------

export const LESSON_STATUSES = ["en_curso", "hecha"] as const;

const lessonProgressSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    lessonId: { type: String, required: true },
    status: { type: String, enum: LESSON_STATUSES, default: "en_curso" },
    /**
     * La pregunta previa (efecto pretesting): se responde ANTES de leer y no
     * muestra la correccion hasta el final de la leccion.
     */
    preAnswers: {
      type: [
        {
          _id: false,
          itemId: String,
          chosen: Number,
          certainty: Number,
          at: Date,
        },
      ],
      default: [],
    },
    /** "Explicalo con tus palabras" (autoexplicacion). */
    explainBack: { type: String, default: "" },
    doneAt: { type: Date },
  },
  { timestamps: true, collection: "academy_lesson_progress" },
);
lessonProgressSchema.index({ userId: 1, lessonId: 1 }, { unique: true });

export type AcademyLessonProgressDoc = InferSchemaType<typeof lessonProgressSchema>;
export const AcademyLessonProgress = model("AcademyLessonProgress", lessonProgressSchema);

// ---------------------------------------------------------------------------
// Tarjetas de repaso espaciado (Leitner de 5 cajas)
// ---------------------------------------------------------------------------

/** Dias hasta la proxima vuelta segun la caja (1..5). */
export const BOX_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;

const cardSchema = new Schema(
  {
    userId: { type: String, required: true },
    itemId: { type: String, required: true },
    box: { type: Number, min: 1, max: 5, default: 1 },
    dueAt: { type: Date, required: true },
    lastResult: { type: Boolean },
    lastCertainty: { type: Number },
    reviews: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "academy_cards" },
);
cardSchema.index({ userId: 1, itemId: 1 }, { unique: true });
cardSchema.index({ userId: 1, dueAt: 1 });

export const AcademyCard = model("AcademyCard", cardSchema);

// ---------------------------------------------------------------------------
// Intentos: diagnostico, examenes y control de retencion
// ---------------------------------------------------------------------------

export const ATTEMPT_KINDS = ["diagnostico", "examen1", "examen2", "examen3", "retencion"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

const attemptSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    kind: { type: String, enum: ATTEMPT_KINDS, required: true },
    /** Ids sorteados al empezar, en el orden en que se mostraron. */
    itemIds: { type: [String], required: true },
    /** Orden de opciones por item (permutacion), para no filtrar la correcta. */
    optionOrders: { type: Schema.Types.Mixed, default: {} },
    answers: {
      type: [
        {
          _id: false,
          itemId: String,
          /** Indice en el orden ORIGINAL del banco (ya des-permutado). */
          chosen: Number,
          certainty: Number,
          hintUsed: Boolean,
          correct: Boolean,
          cbm: Number,
        },
      ],
      default: [],
    },
    pctCorrect: { type: Number },
    cbmTotal: { type: Number },
    criticalOk: { type: Boolean },
    passed: { type: Boolean },
    startedAt: { type: Date, required: true },
    submittedAt: { type: Date },
  },
  { timestamps: true, collection: "academy_attempts" },
);
attemptSchema.index({ userId: 1, kind: 1, startedAt: -1 });

export type AcademyAttemptDoc = InferSchemaType<typeof attemptSchema>;
export const AcademyAttempt = model("AcademyAttempt", attemptSchema);

// ---------------------------------------------------------------------------
// Entregas (una por bloque, adaptada al oficio) con rubrica
// ---------------------------------------------------------------------------

export const SUBMISSION_STATUSES = ["borrador", "enviada", "a_corregir", "aprobada"] as const;
/** Bloques del temario (spec §3): una entrega por bloque, adaptada al oficio. */
export const SUBMISSION_MODULES = ["A", "B", "C", "D", "E", "F"] as const;

const submissionSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    module: { type: String, enum: SUBMISSION_MODULES, required: true },
    draft: { type: String, default: "" },
    link: { type: String, default: "" },
    status: { type: String, enum: SUBMISSION_STATUSES, default: "borrador" },
    /** Rubrica §6.4: cada criterio 0..2. */
    rubric: {
      _id: false,
      fidelidad: Number,
      reglas: Number,
      claridad: Number,
      /** "Sirve para tu rol": gancho en contenido, objeciones en ventas, modelo en desarrollo. */
      oficio: Number,
    },
    feedback: { type: String, default: "" },
    reviewerId: { type: String },
    reviewedAt: { type: Date },
    submittedAt: { type: Date },
  },
  { timestamps: true, collection: "academy_submissions" },
);
submissionSchema.index({ userId: 1, module: 1 }, { unique: true });

export const AcademySubmission = model("AcademySubmission", submissionSchema);

// ---------------------------------------------------------------------------
// Fricciones: donde se trabo usando Roombir (a ciegas y en el ejercicio integrador)
// ---------------------------------------------------------------------------

export const FRICTION_SOURCES = ["a-ciegas", "huesped", "producto", "otro"] as const;

const frictionSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    source: { type: String, enum: FRICTION_SOURCES, required: true },
    screen: { type: String, default: "" },
    note: { type: String, required: true },
  },
  { timestamps: true, collection: "academy_frictions" },
);

export const AcademyFriction = model("AcademyFriction", frictionSchema);

// ---------------------------------------------------------------------------
// Inscripcion: el oficio con el que entra cada persona
// ---------------------------------------------------------------------------

/**
 * El rol de quien entra a Roombir es ambiguo a proposito: el temario es el
 * mismo para todos y el oficio solo cambia el "desde tu oficio" de cada
 * leccion y la consigna de cada entrega.
 */
export const TRACKS = ["contenido", "ventas", "desarrollo", "general"] as const;
export type Track = (typeof TRACKS)[number];

const enrollmentSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    track: { type: String, enum: TRACKS, required: true },
    startedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "academy_enrollments" },
);

export const AcademyEnrollment = model("AcademyEnrollment", enrollmentSchema);

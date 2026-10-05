import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { academyController as c } from "./academy.controller";

/**
 * Academia interna (ROOMBIR-ACADEMY-SPEC.md §7.4).
 *
 * El piso es `support`: quien aprende entra con el rol mas bajo y con TODAS
 * las demas areas en "none" (spec §7.5; un area ausente de `areaAccess` vale
 * "write"). Cada ruta opera solo sobre los datos de quien llama; la vista del
 * equipo y la revision de piezas suben a `admin`.
 */
export const academyRouter = Router();

academyRouter.use(authenticate);

academyRouter.get("/me", authorize("support"), c.me);
academyRouter.put("/enrollment", authorize("support"), c.enroll);

academyRouter.get("/lessons/:lessonId/quiz", authorize("support"), c.lessonQuiz);
academyRouter.post("/lessons/:lessonId/pre-answer", authorize("support"), c.preAnswer);
academyRouter.patch("/lessons/:lessonId", authorize("support"), c.updateLesson);

academyRouter.post("/answer", authorize("support"), c.answer);
academyRouter.get("/review/today", authorize("support"), c.reviewToday);

academyRouter.get("/attempts", authorize("support"), c.listAttempts);
academyRouter.post("/attempts/:kind/start", authorize("support"), c.startAttempt);
academyRouter.post("/attempts/:attemptId/submit", authorize("support"), c.submitAttempt);
academyRouter.get("/attempts/:attemptId", authorize("support"), c.attemptResult);

academyRouter.get("/submissions", authorize("support"), c.listSubmissions);
academyRouter.put("/submissions/:module", authorize("support"), c.saveSubmission);
academyRouter.get("/frictions", authorize("support"), c.listFrictions);
academyRouter.post("/frictions", authorize("support"), c.addFriction);

academyRouter.get("/team", authorize("admin"), c.team);
academyRouter.patch("/team/submissions/:id/review", authorize("admin"), c.reviewSubmission);

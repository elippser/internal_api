import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { knowledgeController } from "./knowledge.controller";

export const knowledgeRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

knowledgeRouter.use(authenticate);

knowledgeRouter.get("/", authorize("analyst"), knowledgeController.list);
knowledgeRouter.get("/:id", authorize("analyst"), knowledgeController.getOne);

knowledgeRouter.post("/", authorize("developer"), knowledgeController.create);
knowledgeRouter.patch("/:id", authorize("developer"), knowledgeController.update);
knowledgeRouter.delete(
  "/:id",
  authorize("developer"),
  knowledgeController.remove,
);

knowledgeRouter.post(
  "/:id/documents",
  authorize("developer"),
  upload.single("file"),
  (req, res, next) => {
    if (req.file) return knowledgeController.createFileDocument(req, res);
    return knowledgeController.createTextDocument(req, res);
  },
);

knowledgeRouter.delete(
  "/:id/documents/:docId",
  authorize("developer"),
  knowledgeController.removeDoc,
);

knowledgeRouter.post(
  "/:id/reindex",
  authorize("developer"),
  knowledgeController.reindex,
);

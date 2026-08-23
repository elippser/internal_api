import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { knowledgeService } from "./knowledge.service";
import {
  createKbSchema,
  createTextDocSchema,
  updateKbSchema,
} from "./knowledge.validation";

export const knowledgeController = {
  async list(_req: Request, res: Response) {
    const result = await knowledgeService.listKbs();
    return ok(res, result);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createKbSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await knowledgeService.createKb(value);
    return ok(res, doc, 201);
  },

  async getOne(req: Request, res: Response) {
    const result = await knowledgeService.getKb(req.params.id);
    if (!result) return fail(res, 404, "KB no encontrada", "not_found");
    return ok(res, result);
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateKbSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await knowledgeService.updateKb(req.params.id, value);
    if (!doc) return fail(res, 404, "KB no encontrada", "not_found");
    return ok(res, doc);
  },

  async remove(req: Request, res: Response) {
    const removed = await knowledgeService.deleteKb(req.params.id);
    if (!removed) return fail(res, 404, "KB no encontrada", "not_found");
    return ok(res, { ok: true });
  },

  // Upload por texto (manual, url, markdown)
  async createTextDocument(req: Request, res: Response) {
    const { error, value } = createTextDocSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await knowledgeService.createDoc({
      knowledgeBaseId: req.params.id,
      ...value,
    });
    return ok(res, doc, 201);
  },

  // Upload por archivo (multipart) - el middleware multer ya parseo el archivo
  async createFileDocument(req: Request, res: Response) {
    const file = req.file;
    if (!file) return fail(res, 400, "Archivo requerido", "missing_file");

    // Detecta tipo por extension del nombre original
    const ext = (file.originalname.split(".").pop() ?? "").toLowerCase();
    const sourceType: "pdf" | "markdown" | "text" =
      ext === "pdf" ? "pdf" : ext === "md" ? "markdown" : "text";

    // Para texto plano / markdown el processor lee el buffer como utf-8.
    // Para PDF lo extrae con pdf-parse.
    const doc = await knowledgeService.createDoc({
      knowledgeBaseId: req.params.id,
      sourceType,
      originalName: file.originalname,
      storageUrl: "",
      fileBuffer: file.buffer,
      metadata: {
        title: file.originalname,
        tags: [],
      },
    });
    return ok(res, doc, 201);
  },

  async removeDoc(req: Request, res: Response) {
    const removed = await knowledgeService.deleteDoc(
      req.params.id,
      req.params.docId,
    );
    if (!removed) return fail(res, 404, "Documento no encontrado", "not_found");
    return ok(res, { ok: true });
  },

  async reindex(req: Request, res: Response) {
    const result = await knowledgeService.reindex(req.params.id);
    if (!result) return fail(res, 404, "KB no encontrada", "not_found");
    return ok(res, result);
  },
};

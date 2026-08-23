/**
 * CRUD de habilidades (§19). Mismo modelo de versionado inmutable que los
 * agentes: guardar el cuerpo crea una versión y mueve el puntero.
 */
import type { Request, Response } from "express";
import Joi from "joi";
import { ConflictError, NotFoundError } from "../../engine/core/errors";
import { newId } from "../../engine/core/ids";
import { currentScope } from "../../engine/core/scope";
import {
  EngineSkill,
  EngineSkillVersion,
  SKILL_SCOPES,
  sanitizeSkill,
} from "../../engine/models/skill.model";
import { resolveSkills } from "../../engine/skills/resolver";
import { scopedFilter } from "../../engine/repositories/base.repository";
import { ok, paginated, parsePagination } from "../../shared/utils/http";
import { validate } from "./engine.validation";

const createSkillSchema = Joi.object({
  name: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/)
    .required()
    .messages({
      "string.pattern.base":
        "El nombre admite minúsculas, números, guion y guion bajo, entre 2 y 64 caracteres.",
    }),
  displayName: Joi.string().allow("").max(120),
  // Obligatoria: es el NIVEL 1. Sin descripción el modelo nunca puede elegirla.
  description: Joi.string().min(10).max(2000).required().messages({
    "any.required":
      "La descripción es obligatoria: es lo único que el modelo ve en el nivel 1, " +
      "así que una habilidad sin descripción jamás puede ser elegida.",
    "string.min": "La descripción tiene que decir cuándo usar la habilidad (mínimo 10 caracteres).",
  }),
  body: Joi.string().allow("").max(200_000),
  scope: Joi.string().valid(...SKILL_SCOPES),
  agentId: Joi.string().allow(null),
  tags: Joi.array().items(Joi.string()),
}).required();

const updateBodySchema = Joi.object({
  body: Joi.string().allow("").max(200_000).required(),
  description: Joi.string().min(10).max(2000),
  changeNote: Joi.string().allow("", null).max(500),
}).required();

export const engineSkillsController = {
  async list(req: Request, res: Response) {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter: Record<string, unknown> = { deletedAt: null };
    if (req.query.scope) filter.scope = req.query.scope;
    if (req.query.agentId) filter.agentId = req.query.agentId;
    if (req.query.search) {
      const re = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: re }, { displayName: re }, { description: re }];
    }

    const scoped = scopedFilter(filter);
    const [docs, total] = await Promise.all([
      EngineSkill.find(scoped).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      EngineSkill.countDocuments(scoped),
    ]);

    return paginated(res, docs.map((d) => sanitizeSkill(d)), total, page, limit);
  },

  async getOne(req: Request, res: Response) {
    const doc = await EngineSkill.findOne(
      scopedFilter({ skillId: req.params.id, deletedAt: null }),
    ).lean();
    if (!doc) throw new NotFoundError(`Habilidad no encontrada: ${req.params.id}`);

    const [activeVersion, versions] = await Promise.all([
      doc.activeVersionId
        ? EngineSkillVersion.findOne({ versionId: doc.activeVersionId }).lean()
        : null,
      EngineSkillVersion.find({ skillId: doc.skillId })
        .sort({ version: -1 })
        .limit(30)
        .lean(),
    ]);

    return ok(res, {
      ...sanitizeSkill(doc),
      activeVersion,
      versions: versions.map((v) => ({
        versionId: v.versionId,
        version: v.version,
        changeNote: v.changeNote,
        createdAt: v.createdAt,
        isActive: v.versionId === doc.activeVersionId,
      })),
    });
  },

  /**
   * Qué habilidades ve REALMENTE un agente, ya desambiguadas por precedencia.
   * Es la vista que importa al configurar: la lista cruda no dice cuál gana
   * cuando dos ámbitos definen el mismo nombre.
   */
  async forAgent(req: Request, res: Response) {
    const scope = currentScope();
    return ok(
      res,
      await resolveSkills({
        tenantId: scope.tenantId,
        agentId: req.params.agentId,
        userId: scope.userId,
      }),
    );
  },

  async create(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(createSkillSchema, req.body);
    const scope = currentScope();
    const skillScope = (payload.scope as string) ?? "tenant";

    if (skillScope === "agent" && !payload.agentId) {
      throw new ConflictError('Una habilidad de ámbito "agent" necesita `agentId`.');
    }

    const skillId = newId("skill");
    const versionId = newId("skv");

    try {
      await EngineSkill.create({
        skillId,
        name: String(payload.name),
        displayName: String(payload.displayName ?? payload.name),
        description: String(payload.description),
        scope: skillScope,
        tenantId: skillScope === "global" ? null : scope.tenantId,
        agentId: skillScope === "agent" ? String(payload.agentId) : null,
        ownerUserId: skillScope === "user" ? scope.userId : null,
        activeVersionId: versionId,
        tags: (payload.tags as string[]) ?? [],
        createdByUserId: req.internalUser!.userId,
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        throw new ConflictError(
          `Ya existe una habilidad "${payload.name}" en el ámbito "${skillScope}".`,
        );
      }
      throw err;
    }

    await EngineSkillVersion.create({
      versionId,
      skillId,
      version: 1,
      body: String(payload.body ?? ""),
      description: String(payload.description),
      changeNote: "Versión inicial",
      createdByUserId: req.internalUser!.userId,
    });

    return ok(res, { skillId, versionId, version: 1 }, 201);
  },

  /** Guardar el cuerpo CREA una versión. No sobrescribe (§35.1). */
  async saveVersion(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(updateBodySchema, req.body);
    const skill = await EngineSkill.findOne(
      scopedFilter({ skillId: req.params.id, deletedAt: null }),
    ).lean();
    if (!skill) throw new NotFoundError(`Habilidad no encontrada: ${req.params.id}`);

    const last = await EngineSkillVersion.findOne({ skillId: skill.skillId })
      .sort({ version: -1 })
      .select({ version: 1 })
      .lean();

    const versionId = newId("skv");
    const description = String(payload.description ?? skill.description);

    await EngineSkillVersion.create({
      versionId,
      skillId: skill.skillId,
      version: (last?.version ?? 0) + 1,
      body: String(payload.body ?? ""),
      description,
      changeNote: (payload.changeNote as string) ?? null,
      createdByUserId: req.internalUser!.userId,
    });

    await EngineSkill.updateOne(
      { skillId: skill.skillId },
      { $set: { activeVersionId: versionId, description } },
    );

    return ok(res, { skillId: skill.skillId, versionId, version: (last?.version ?? 0) + 1 }, 201);
  },

  /** Reversión: mover el puntero. */
  async activateVersion(req: Request, res: Response) {
    const skill = await EngineSkill.findOne(
      scopedFilter({ skillId: req.params.id, deletedAt: null }),
    ).lean();
    if (!skill) throw new NotFoundError(`Habilidad no encontrada: ${req.params.id}`);

    const version = await EngineSkillVersion.findOne({
      skillId: skill.skillId,
      versionId: req.params.versionId,
    }).lean();
    if (!version) throw new NotFoundError(`Versión no encontrada: ${req.params.versionId}`);

    await EngineSkill.updateOne(
      { skillId: skill.skillId },
      { $set: { activeVersionId: version.versionId, description: version.description } },
    );
    return ok(res, { skillId: skill.skillId, activeVersionId: version.versionId });
  },

  async remove(req: Request, res: Response) {
    const doc = await EngineSkill.findOneAndUpdate(
      scopedFilter({ skillId: req.params.id, deletedAt: null }),
      { $set: { status: "disabled", deletedAt: new Date() } },
      { new: true },
    ).lean();
    if (!doc) throw new NotFoundError(`Habilidad no encontrada: ${req.params.id}`);
    return ok(res, sanitizeSkill(doc));
  },
};

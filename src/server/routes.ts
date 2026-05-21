import express from "express";
import multer from "multer";
import type { CandidateRepository } from "./repositories/CandidateRepository";
import type { RecruitmentMessageService } from "./services/RecruitmentMessageService";
import type { WeComBotAdapter } from "./wecom/WeComBotAdapter";
import type { RecruitmentStage } from "../shared/types";
import type { DocumentTextExtractor } from "./documents/PdfTextExtractor";
import { ExcelExportService } from "./services/ExcelExportService";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

export function createRouter(deps: {
  repository: CandidateRepository;
  service: RecruitmentMessageService;
  wecomAdapter: WeComBotAdapter;
  documentExtractor?: DocumentTextExtractor;
  excelExportService?: ExcelExportService;
}): express.Router {
  const router = express.Router();
  const excelExportService = deps.excelExportService ?? new ExcelExportService();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  router.delete("/demo-data", async (_req, res, next) => {
    try {
      await deps.repository.clear();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/wecom/aibot/callback", (req, res) => {
    void deps.wecomAdapter.verifyUrl(req, res);
  });

  router.post(
    "/wecom/aibot/callback",
    express.text({ type: ["application/xml", "text/xml", "text/plain", "*/*"] }),
    (req, res) => {
      void deps.wecomAdapter.receive(req, res);
    }
  );

  router.post("/messages/simulate", express.json(), async (req, res, next) => {
    try {
      const result = await deps.service.process({
        source: "local_simulator",
        kind: req.body.kind,
        content: String(req.body.content ?? ""),
        sender: req.body.sender,
        groupName: req.body.groupName ?? "招聘内部协作群",
        messageId: req.body.messageId
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/messages/upload-pdf", upload.single("file"), async (req, res, next) => {
    try {
      if (!deps.documentExtractor) {
        res.status(500).json({ message: "未配置 PDF 文本抽取器" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "请上传 PDF 文件" });
        return;
      }
      const jobTitle = String(req.body.jobTitle ?? "").trim();
      if (!jobTitle) {
        res.status(400).json({ message: "上传 PDF 简历时必须填写目标岗位" });
        return;
      }
      const extractedText = await deps.documentExtractor.extractPdf(req.file.buffer);
      const result = await deps.service.process({
        source: "local_simulator",
        kind: "resume_pdf",
        content: extractedText,
        sender: String(req.body.sender ?? "PDF上传"),
        groupName: String(req.body.groupName ?? "招聘内部协作群"),
        attachment: {
          fileName: req.file.originalname,
          jobTitle,
          mimeType: req.file.mimetype,
          size: req.file.size,
          extractedText
        }
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/messages", async (_req, res, next) => {
    try {
      const data = await deps.repository.all();
      res.json(data.messages);
    } catch (error) {
      next(error);
    }
  });

  router.get("/candidates", async (req, res, next) => {
    try {
      const candidates = await deps.repository.listCandidates({
        stage: req.query.stage as RecruitmentStage | undefined,
        position: req.query.position ? String(req.query.position) : undefined,
        owner: req.query.owner ? String(req.query.owner) : undefined
      });
      res.json(candidates);
    } catch (error) {
      next(error);
    }
  });

  router.get("/candidates/:id", async (req, res, next) => {
    try {
      const candidate = await deps.repository.getCandidate(req.params.id);
      if (!candidate) {
        res.status(404).json({ message: "候选人不存在" });
        return;
      }
      res.json(candidate);
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs", async (_req, res, next) => {
    try {
      res.json(await deps.repository.listJobs());
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs", express.json(), async (req, res, next) => {
    try {
      const job = await deps.repository.upsertJobRequirement({
        title: String(req.body.title ?? ""),
        targetHeadcount: req.body.targetHeadcount === undefined ? undefined : Number(req.body.targetHeadcount),
        owner: req.body.owner,
        requirements: Array.isArray(req.body.requirements) ? req.body.requirements : [],
        supplement: req.body.supplement,
        status: req.body.status
      });
      res.status(201).json(job);
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs/:id", async (req, res, next) => {
    try {
      const job = await deps.repository.getJob(req.params.id);
      if (!job) {
        res.status(404).json({ message: "岗位不存在" });
        return;
      }
      const progress = await deps.repository.jobProgress(job.id);
      res.json({ job, progress });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/jobs/:id", express.json(), async (req, res, next) => {
    try {
      const job = await deps.repository.updateJob(req.params.id, req.body);
      if (!job) {
        res.status(404).json({ message: "岗位不存在" });
        return;
      }
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/generate-jd", async (req, res, next) => {
    try {
      const job = await deps.repository.getJob(req.params.id);
      if (!job) {
        res.status(404).json({ message: "岗位不存在" });
        return;
      }
      const jdDraft = await deps.service.generateJdForJob(job);
      const updated = await deps.repository.updateJob(job.id, { jdDraft });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs/:id/export.xlsx", async (req, res, next) => {
    try {
      const job = await deps.repository.getJob(req.params.id);
      if (!job) {
        res.status(404).json({ message: "岗位不存在" });
        return;
      }
      const progress = await deps.repository.jobProgress(job.id);
      const buffer = await excelExportService.exportJobProgress(job, progress);
      const fileName = encodeURIComponent(`${job.title}-招聘进度.xlsx`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  });

  router.get("/pending-tasks", async (_req, res, next) => {
    try {
      res.json(await deps.repository.listPendingTasks());
    } catch (error) {
      next(error);
    }
  });

  router.post("/pending-tasks/:id/resolve", async (req, res, next) => {
    try {
      const task = await deps.repository.resolvePendingTask(req.params.id);
      if (!task) {
        res.status(404).json({ message: "待确认任务不存在" });
        return;
      }
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/candidates/:id/stage", express.json(), async (req, res, next) => {
    try {
      const candidate = await deps.repository.updateStage(req.params.id, req.body.stage);
      if (!candidate) {
        res.status(404).json({ message: "候选人不存在" });
        return;
      }
      res.json(candidate);
    } catch (error) {
      next(error);
    }
  });

  router.get("/dashboard/metrics", async (_req, res, next) => {
    try {
      res.json(await deps.repository.metrics());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

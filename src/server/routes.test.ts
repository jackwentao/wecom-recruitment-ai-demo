import express from "express";
import ExcelJS from "exceljs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Candidate } from "../shared/types";
import { RuleBasedFallbackExtractor } from "./ai/AiExtractor";
import { PlainTextDocumentExtractor } from "./documents/PdfTextExtractor";
import { CandidateRepository } from "./repositories/CandidateRepository";
import { createRouter } from "./routes";
import { RecruitmentMessageService } from "./services/RecruitmentMessageService";
import { WeComBotAdapter } from "./wecom/WeComBotAdapter";
import { WeComCrypto } from "./wecom/WeComCrypto";

let tempDir = "";
let server: http.Server | undefined;
const now = "2026-05-22T07:00:00.000Z";

function buildRouteCandidate(patch: Partial<Candidate>): Candidate {
  return {
    id: patch.id ?? "candidate-id",
    name: patch.name ?? "张三",
    phone: patch.phone,
    jobId: patch.jobId,
    position: patch.position ?? "Java后端",
    stage: patch.stage ?? "screening",
    owner: patch.owner,
    sourceGroup: patch.sourceGroup,
    interviewTime: patch.interviewTime,
    summary: patch.summary ?? "候选人摘要",
    risks: patch.risks ?? [],
    nextAction: patch.nextAction ?? "继续跟进",
    confidence: patch.confidence ?? 0.8,
    resumeProfile: patch.resumeProfile,
    matchScore: patch.matchScore,
    evaluation: patch.evaluation,
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    timeline: patch.timeline ?? []
  };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("API routes", () => {
  it("可以通过模拟消息接口完成入库并查询驾驶舱指标", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-api-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "Java后端" });
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("token"), service, { replyEnabled: false }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务启动失败");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const ingestResponse = await fetch(`${baseUrl}/api/messages/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进"
      })
    });
    expect(ingestResponse.ok).toBe(true);
    const metricsResponse = await fetch(`${baseUrl}/api/dashboard/metrics`);
    const metrics = await metricsResponse.json();

    expect(metrics.totalCandidates).toBe(1);
    expect(metrics.openTasks).toBe(1);
    expect(metrics.parseSuccessRate).toBe(100);
  });

  it("可以通过PDF上传接口抽取文本并进入候选人链路", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-api-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "高级产品经理" });
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("token"), service, { replyEnabled: false }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务启动失败");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const formData = new FormData();
    formData.append(
      "file",
      new Blob(["李梅 产品经理候选人，周五上午10点业务面，赵婷负责"], { type: "application/pdf" }),
      "李梅简历.pdf"
    );
    formData.append("jobTitle", "高级产品经理");

    const response = await fetch(`${baseUrl}/api/messages/upload-pdf`, {
      method: "POST",
      body: formData
    });
    const result = await response.json();

    expect(response.ok).toBe(true);
    expect(result.message.kind).toBe("resume_pdf");
    expect(result.candidate.name).toBe("李梅");
    expect(result.candidate.position).toBe("高级产品经理");
  });

  it("上传PDF简历时必须同时填写目标岗位", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-api-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("token"), service, { replyEnabled: false }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务启动失败");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const formData = new FormData();
    formData.append("file", new Blob(["李梅 产品经理候选人"], { type: "application/pdf" }), "李梅简历.pdf");

    const response = await fetch(`${baseUrl}/api/messages/upload-pdf`, {
      method: "POST",
      body: formData
    });
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.message).toContain("目标岗位");
  });

  it("可以录入岗位需求、查询岗位进度并导出Excel", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-api-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("token"), service, { replyEnabled: false }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务启动失败");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/api/messages/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "@招聘助手 Java后端岗位招3人，要求3年以上经验，王工负责"
      })
    });
    await fetch(`${baseUrl}/api/messages/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进"
      })
    });
    const jobs = await fetch(`${baseUrl}/api/jobs`).then((res) => res.json());
    const candidateNames = ["张三", "李四", "王五", "赵六", "钱七", "孙八"];
    const data = await repository.all();
    await repository.save({
      ...data,
      candidates: candidateNames.map((name, index) =>
        buildRouteCandidate({
          id: `candidate-${index}`,
          name,
          jobId: jobs[0].id,
          position: jobs[0].title,
          matchScore: 90 - index,
          summary: `${name} Java后端候选人`
        })
      )
    });
    const detail = await fetch(`${baseUrl}/api/jobs/${jobs[0].id}`).then((res) => res.json());
    const excel = await fetch(`${baseUrl}/api/jobs/${jobs[0].id}/export.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const excelBuffer = Buffer.from(await excel.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(excelBuffer);
    const candidateDetail = workbook.getWorksheet("候选人明细");

    expect(jobs[0].title).toContain("Java");
    expect(detail.progress.effectiveCandidates).toBe(6);
    expect(detail.progress.candidates).toHaveLength(6);
    expect(excel.ok).toBe(true);
    expect(excel.headers.get("content-type")).toContain("spreadsheet");
    expect(candidateDetail?.getColumn(1).values).toEqual(expect.arrayContaining(candidateNames));
  });

  it("可以清空演示数据", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-api-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("token"), service, { replyEnabled: false }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务启动失败");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/api/messages/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "@招聘助手 Java后端岗位招3人，王工负责"
      })
    });
    await fetch(`${baseUrl}/api/messages/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "@招聘助手 张三 Java后端候选人，王工跟进"
      })
    });

    const clearResponse = await fetch(`${baseUrl}/api/demo-data`, { method: "DELETE" });
    const metrics = await fetch(`${baseUrl}/api/dashboard/metrics`).then((res) => res.json());
    const messages = await fetch(`${baseUrl}/api/messages`).then((res) => res.json());
    const jobs = await fetch(`${baseUrl}/api/jobs`).then((res) => res.json());

    expect(clearResponse.ok).toBe(true);
    expect(metrics.totalCandidates).toBe(0);
    expect(metrics.openTasks).toBe(0);
    expect(messages).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });
});

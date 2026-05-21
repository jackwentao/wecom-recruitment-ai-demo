import express from "express";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { OpenAiCompatibleExtractor, ResilientAiExtractor, RuleBasedFallbackExtractor } from "../src/server/ai/AiExtractor";
import { config } from "../src/server/config";
import { PdfTextExtractor } from "../src/server/documents/PdfTextExtractor";
import { CandidateRepository } from "../src/server/repositories/CandidateRepository";
import { createRouter } from "../src/server/routes";
import { RecruitmentMessageService } from "../src/server/services/RecruitmentMessageService";
import { WeComBotAdapter } from "../src/server/wecom/WeComBotAdapter";
import { WeComCrypto } from "../src/server/wecom/WeComCrypto";

const pdfPath = process.argv[2] ?? process.env.PDF_PATH;
const jobTitle = process.argv[3] ?? process.env.JOB_TITLE ?? "Java后端";

function sanitizeError(error: unknown) {
  const maybe = error as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: unknown };
  };
  return {
    code: maybe?.code,
    status: maybe?.response?.status,
    data: maybe?.response?.data,
    message: maybe instanceof Error ? maybe.message : String(error)
  };
}

async function closeServer(server: http.Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main() {
  if (!pdfPath) throw new Error("请传入 PDF 路径，例如：npm run smoke:pdf-e2e -- C:\\path\\resume.pdf Java后端");
  if (!config.ai.baseUrl || !config.ai.apiKey) throw new Error("请先配置 OPENAI_BASE_URL 和 OPENAI_API_KEY。");

  const pdf = await readFile(pdfPath);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-e2e-smoke-"));
  let server: http.Server | undefined;

  try {
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const ai = new ResilientAiExtractor(
      new OpenAiCompatibleExtractor(config.ai),
      new RuleBasedFallbackExtractor()
    );
    const service = new RecruitmentMessageService(repository, ai);
    const documentExtractor = new PdfTextExtractor();
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("smoke-token"), service, { replyEnabled: false }),
        documentExtractor
      })
    );

    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("本地测试服务启动失败。");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const formData = new FormData();
    formData.append("file", new Blob([pdf], { type: "application/pdf" }), path.basename(pdfPath));
    formData.append("jobTitle", jobTitle);
    formData.append("sender", "PDF端到端测试");
    formData.append("groupName", "招聘端到端测试");

    console.log(`PDF E2E smoke test: file=${pdfPath}`);
    console.log(`Target job: ${jobTitle}`);
    console.log(`DeepSeek: baseUrl=${config.ai.baseUrl}, model=${config.ai.model}, apiKey=已配置`);

    const response = await fetch(`${baseUrl}/api/messages/upload-pdf`, {
      method: "POST",
      body: formData
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(`PDF上传接口失败：status=${response.status}, body=${JSON.stringify(result)}`);
    }

    const candidates = await repository.listCandidates({});
    const candidate = result.candidate ?? candidates[0];
    if (!candidate) throw new Error("PDF上传成功但没有候选人入库。");

    const safeResult = {
      messageStatus: result.message?.status,
      messageKind: result.message?.kind,
      candidate: {
        name: candidate.name,
        position: candidate.position,
        stage: candidate.stage,
        matchScore: candidate.matchScore,
        recommendation: candidate.evaluation?.recommendation,
        abilityAssessment: candidate.evaluation?.abilityAssessment,
        resumeProfile: candidate.resumeProfile
          ? {
              email: candidate.resumeProfile.email,
              location: candidate.resumeProfile.location,
              birthDate: candidate.resumeProfile.birthDate,
              workYears: candidate.resumeProfile.workYears,
              education: candidate.resumeProfile.education,
              internships: candidate.resumeProfile.internships,
              workExperiences: candidate.resumeProfile.workExperiences,
              projects: candidate.resumeProfile.projects,
              skills: candidate.resumeProfile.skills
            }
          : undefined,
        risksCount: candidate.risks?.length ?? 0,
        timelineCount: candidate.timeline?.length ?? 0,
        evaluationSummary: candidate.evaluation?.summary
      },
      repository: {
        candidates: candidates.length
      }
    };

    console.log("\n[PASS] 真实PDF上传、文本抽取、LLM解析、匹配评估、入库全部完成");
    console.log(JSON.stringify(safeResult, null, 2));
  } finally {
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(JSON.stringify(sanitizeError(error), null, 2));
  process.exit(1);
});

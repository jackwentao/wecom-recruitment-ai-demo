import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ClassifiedTask, ParsedJobRequirement, RecruitmentAi } from "../src/server/ai/AiExtractor";
import { PlainTextDocumentExtractor } from "../src/server/documents/PdfTextExtractor";
import { CandidateRepository } from "../src/server/repositories/CandidateRepository";
import { createRouter } from "../src/server/routes";
import { RecruitmentMessageService } from "../src/server/services/RecruitmentMessageService";
import { WeComBotAdapter } from "../src/server/wecom/WeComBotAdapter";
import { WeComCrypto } from "../src/server/wecom/WeComCrypto";
import type {
  Candidate,
  ExtractedRecruitmentInfo,
  JobProgress,
  JobRequirement,
  PendingTask,
  ProcessResult,
  RecruitmentMessageKind,
  ResumeEvaluation
} from "../src/shared/types";

type StepResult = {
  name: string;
  detail: Record<string, unknown>;
};

class NegativeScenarioAi implements RecruitmentAi {
  async classifyTask(input: { content: string; kind: RecruitmentMessageKind }): Promise<ClassifiedTask> {
    const content = input.content;
    if (input.kind === "resume_pdf") return { type: "resume_parse_match", confidence: 0.95 };
    if (/T\d{8}[A-Z0-9]{4}/.test(content)) return { type: "unknown", confidence: 0.9 };
    if (/查一下|查询|进展/.test(content) && /李四/.test(content)) {
      return { type: "candidate_query", confidence: 0.95, candidateName: "李四" };
    }
    if (/进度|招得怎么样/.test(content) && /Go后端/.test(content)) {
      return { type: "job_progress_query", confidence: 0.95, jobTitle: "Go后端" };
    }
    if (/天气|午饭|闲聊/.test(content)) return { type: "unknown", confidence: 0.95 };
    if (/岗位|需求/.test(content) && /Java后端/.test(content)) {
      return { type: "job_requirement", confidence: 0.95, jobTitle: "Java后端" };
    }
    return { type: "resume_parse_match", confidence: 0.95, candidateName: "李四", jobTitle: "Go后端" };
  }

  async extract(): Promise<ExtractedRecruitmentInfo> {
    return {
      candidateName: "李四",
      phone: "13900139000",
      position: "Go后端",
      stage: "interview_scheduled",
      interviewTime: "明天下午4点",
      owner: "赵工",
      sourceGroup: "招聘内部协作群",
      summary: "李四应聘Go后端，明天下午4点一面。",
      risks: [],
      nextAction: "等待岗位确认后再入库",
      confidence: 0.9
    };
  }

  async parseJobRequirement(): Promise<ParsedJobRequirement> {
    return {
      title: "Java后端",
      targetHeadcount: 2,
      owner: "王工",
      requirements: ["3年以上Java经验"],
      supplement: "用于反向测试的已存在岗位。"
    };
  }

  async evaluateResume(input: { candidate: ExtractedRecruitmentInfo; jobTitle: string }): Promise<ResumeEvaluation> {
    return {
      matchScore: 60,
      recommendation: "weak_match",
      abilityAssessment: {
        technical: 60,
        project: 58,
        domain: 55,
        communication: 60,
        stability: 60
      },
      strengths: [],
      weaknesses: ["岗位未确认，不应进入正式评估"],
      risks: input.candidate.risks,
      interviewFocus: [],
      summary: `${input.candidate.candidateName}尚未绑定有效${input.jobTitle}岗位。`
    };
  }

  async generateJd(job: JobRequirement): Promise<string> {
    return `# ${job.title} JD`;
  }

  async summarizeJobProgress(progress: JobProgress): Promise<string> {
    return `${progress.title}进度待确认。`;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function postJson<T>(baseUrl: string, pathName: string, body: unknown): Promise<{ status: number; ok: boolean; data: T }> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, ok: response.ok, data: (await response.json()) as T };
}

async function getJson<T>(baseUrl: string, pathName: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`);
  const result = await response.json();
  assert(response.ok, `${pathName} 请求失败：${JSON.stringify(result)}`);
  return result as T;
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-negative-e2e-"));
  let server: http.Server | undefined;
  const steps: StepResult[] = [];

  try {
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const service = new RecruitmentMessageService(repository, new NegativeScenarioAi());
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(new WeComCrypto("test-token"), service, { replyEnabled: false }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );
    server = app.listen(0);
    const address = server.address();
    assert(address && typeof address !== "string", "测试服务启动失败");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const registeredJob = await postJson<JobRequirement>(baseUrl, "/api/jobs", {
      title: "Java后端",
      targetHeadcount: 2,
      owner: "王工"
    });
    assert(registeredJob.ok, "预置Java后端岗位失败");

    const missingJobCandidate = await postJson<ProcessResult>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 李四 Go后端候选人，明天下午4点一面，赵工跟进，手机号13900139000",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    let candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(missingJobCandidate.ok, "缺失岗位候选人请求本身应被接收");
    assert(missingJobCandidate.data.message.status === "needs_review", "岗位不存在时消息必须进入待确认");
    assert(Boolean(missingJobCandidate.data.pendingTask?.id), "岗位不存在时必须生成待确认任务ID");
    assert(candidates.length === 0, `岗位不存在时不能入库候选人，实际${candidates.length}`);
    steps.push({
      name: "岗位不存在的候选人不能入库",
      detail: {
        messageStatus: missingJobCandidate.data.message.status,
        pendingTaskId: missingJobCandidate.data.pendingTask?.id,
        candidateCount: candidates.length,
        replyText: missingJobCandidate.data.replyText
      }
    });

    const pendingTaskId = missingJobCandidate.data.pendingTask?.id;
    assert(pendingTaskId, "缺失岗位候选人测试没有拿到任务ID");
    const invalidConfirm = await postJson<ProcessResult>(baseUrl, "/api/messages/simulate", {
      content: `${pendingTaskId} invalid-job-id`,
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    const pendingTasksAfterInvalid = await getJson<PendingTask[]>(baseUrl, "/api/pending-tasks");
    assert(invalidConfirm.data.message.status === "needs_review", "错误岗位ID确认不能成功");
    assert(candidates.length === 0, `错误岗位ID确认后不能入库候选人，实际${candidates.length}`);
    assert(pendingTasksAfterInvalid.some((task) => task.id === pendingTaskId && task.status === "waiting"), "错误岗位ID不能关闭原待确认任务");
    steps.push({
      name: "错误岗位ID不能继续原任务",
      detail: {
        messageStatus: invalidConfirm.data.message.status,
        candidateCount: candidates.length,
        pendingStillWaiting: pendingTasksAfterInvalid.some((task) => task.id === pendingTaskId && task.status === "waiting"),
        replyText: invalidConfirm.data.replyText
      }
    });

    const pdfForm = new FormData();
    pdfForm.append("file", new Blob(["李四 Go后端 简历文本"], { type: "application/pdf" }), "李四简历.pdf");
    const pdfResponse = await fetch(`${baseUrl}/api/messages/upload-pdf`, {
      method: "POST",
      body: pdfForm
    });
    const pdfResult = await pdfResponse.json();
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(pdfResponse.status === 400, `PDF不带岗位应返回400，实际${pdfResponse.status}`);
    assert(candidates.length === 0, `PDF不带岗位不能入库候选人，实际${candidates.length}`);
    steps.push({
      name: "PDF不带目标岗位不能解析入库",
      detail: {
        status: pdfResponse.status,
        candidateCount: candidates.length,
        message: pdfResult.message
      }
    });

    const unknownCandidateQuery = await postJson<ProcessResult>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 查一下李四进展",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(unknownCandidateQuery.data.message.status === "parsed", "查询不存在候选人可以被解析，但不能创建候选人");
    assert(!unknownCandidateQuery.data.candidate, "查询不存在候选人不能返回候选人实体");
    assert(candidates.length === 0, `查询不存在候选人不能新建候选人，实际${candidates.length}`);
    steps.push({
      name: "查询不存在候选人不能新建候选人",
      detail: {
        messageStatus: unknownCandidateQuery.data.message.status,
        returnedCandidate: Boolean(unknownCandidateQuery.data.candidate),
        candidateCount: candidates.length,
        replyText: unknownCandidateQuery.data.replyText
      }
    });

    const missingJobProgress = await postJson<ProcessResult>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 Go后端现在进度怎么样",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    const jobs = await getJson<JobRequirement[]>(baseUrl, "/api/jobs");
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(missingJobProgress.data.message.status === "needs_review", "不存在岗位的进度查询必须进入待确认");
    assert(!missingJobProgress.data.progress, "不存在岗位不能返回假进度");
    assert(jobs.length === 1 && jobs[0].id === registeredJob.data.id, "不存在岗位查询不能创建新岗位");
    assert(candidates.length === 0, "不存在岗位查询不能创建候选人");
    steps.push({
      name: "不存在岗位进度查询不能成功",
      detail: {
        messageStatus: missingJobProgress.data.message.status,
        returnedProgress: Boolean(missingJobProgress.data.progress),
        jobCount: jobs.length,
        candidateCount: candidates.length,
        replyText: missingJobProgress.data.replyText
      }
    });

    const unknownMessage = await postJson<ProcessResult>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 今天天气怎么样，午饭吃什么",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(unknownMessage.data.message.status === "needs_review", "非招聘闲聊不能被当成成功招聘任务");
    assert(Boolean(unknownMessage.data.pendingTask?.id), "非招聘闲聊应进入待确认任务");
    assert(candidates.length === 0, "非招聘闲聊不能创建候选人");
    steps.push({
      name: "非招聘消息不能误执行",
      detail: {
        messageStatus: unknownMessage.data.message.status,
        pendingTaskId: unknownMessage.data.pendingTask?.id,
        candidateCount: candidates.length,
        replyText: unknownMessage.data.replyText
      }
    });

    console.log("招聘链路反向测试通过。");
    for (const step of steps) {
      console.log(`\n[PASS] ${step.name}`);
      console.log(JSON.stringify(step.detail, null, 2));
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("招聘链路反向测试失败：");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { RecruitmentAi, ClassifiedTask, ParsedJobRequirement } from "../src/server/ai/AiExtractor";
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
  RecruitmentMessageKind,
  ResumeEvaluation
} from "../src/shared/types";

type StepResult = {
  name: string;
  detail: Record<string, unknown>;
};

class ScenarioRecruitmentAi implements RecruitmentAi {
  async classifyTask(input: { content: string; kind: RecruitmentMessageKind; fileName?: string }): Promise<ClassifiedTask> {
    const content = input.content;
    if (input.kind === "resume_pdf") return { type: "resume_parse_match", confidence: 0.95, jobTitle: "Java后端" };
    if (/查一下|查询|进展|进度/.test(content) && /张三/.test(content)) {
      return { type: "candidate_query", confidence: 0.95, candidateName: "张三" };
    }
    if (/进展|进度|招得怎么样/.test(content) && /Java后端/.test(content)) {
      return { type: "job_progress_query", confidence: 0.95, jobTitle: "Java后端" };
    }
    if (/候选人|手机号|简历/.test(content) && /张三/.test(content) && /Java后端/.test(content)) {
      return { type: "resume_parse_match", confidence: 0.95, candidateName: "张三", jobTitle: "Java后端" };
    }
    if (/岗位|需求|JD|补充/.test(content) && /Java后端/.test(content) && !/候选人/.test(content)) {
      return { type: "job_requirement", confidence: 0.95, jobTitle: "Java后端" };
    }
    if (/一面|反馈|不错|表达能力|淘汰|不合适|通过|二面/.test(content)) {
      return { type: "interview_feedback", confidence: 0.95, candidateName: "张三" };
    }
    return { type: "resume_parse_match", confidence: 0.9, candidateName: "张三", jobTitle: "Java后端" };
  }

  async extract(message: string): Promise<ExtractedRecruitmentInfo> {
    const source = this.lastUserMessage(message);
    if (/淘汰|不合适|拒绝/.test(source)) {
      return {
        candidateName: "张三",
        position: "待确认岗位",
        stage: "rejected",
        owner: "王工",
        summary: "张三沟通后不合适，已淘汰。",
        risks: ["面试结论不合适"],
        nextAction: "归档淘汰原因",
        confidence: 0.92
      };
    }
    if (/表达能力|一面不错|反馈/.test(source)) {
      return {
        candidateName: "张三",
        position: "待确认岗位",
        stage: "interviewing",
        owner: "王工",
        summary: "张三一面不错，表达能力清晰，建议安排二面。",
        risks: [],
        nextAction: "安排二面",
        confidence: 0.9
      };
    }
    return {
      candidateName: "张三",
      phone: "13800138000",
      position: "Java后端",
      stage: "interview_scheduled",
      interviewTime: "明天下午3点",
      owner: "王工",
      sourceGroup: "招聘内部协作群",
      summary: "张三应聘Java后端，明天下午3点一面，王工跟进。",
      risks: [],
      nextAction: "等待一面反馈",
      confidence: 0.93
    };
  }

  async parseJobRequirement(): Promise<ParsedJobRequirement> {
    return {
      title: "Java后端",
      targetHeadcount: 3,
      owner: "王工",
      requirements: ["3年以上Java后端经验", "熟悉Spring Boot、MySQL、Redis", "有微服务或高并发项目经验"],
      supplement: "岗位需求已通过群消息补充。"
    };
  }

  async evaluateResume(input: { candidate: ExtractedRecruitmentInfo; jobTitle: string }): Promise<ResumeEvaluation> {
    return {
      matchScore: 86,
      recommendation: "match",
      abilityAssessment: {
        technical: 86,
        project: 82,
        domain: 78,
        communication: 80,
        stability: 76
      },
      strengths: ["Java后端基础匹配", "项目经历与目标岗位相关"],
      weaknesses: ["需要继续核实微服务深度"],
      risks: input.candidate.risks,
      interviewFocus: ["追问微服务治理经验", "核实高并发项目职责"],
      summary: `${input.candidate.candidateName}与${input.jobTitle}岗位匹配度86分，建议继续推进。`
    };
  }

  async generateJd(job: JobRequirement): Promise<string> {
    return `# ${job.title} JD\n\n负责Java后端核心服务开发，要求熟悉Spring Boot、MySQL、Redis和微服务。`;
  }

  async summarizeJobProgress(progress: JobProgress): Promise<string> {
    return `${progress.title}当前候选人${progress.totalCandidates}人，有效推进${progress.effectiveCandidates}人，Offer ${progress.offerCandidates}人。`;
  }

  private lastUserMessage(message: string): string {
    return (
      message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) ?? message
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function postJson<T>(baseUrl: string, pathName: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  assert(response.ok, `${pathName} 请求失败：${JSON.stringify(result)}`);
  return result as T;
}

async function getJson<T>(baseUrl: string, pathName: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`);
  const result = await response.json();
  assert(response.ok, `${pathName} 请求失败：${JSON.stringify(result)}`);
  return result as T;
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-flow-e2e-"));
  let server: http.Server | undefined;
  const steps: StepResult[] = [];

  try {
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const service = new RecruitmentMessageService(repository, new ScenarioRecruitmentAi());
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
      owner: "王工",
      supplement: "先注册岗位，后续通过群消息补充需求。"
    });
    steps.push({
      name: "岗位注册",
      detail: { jobId: registeredJob.id, title: registeredJob.title, targetHeadcount: registeredJob.targetHeadcount }
    });

    const jobRequirementResult = await postJson<{ job: JobRequirement; replyText: string }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 Java后端岗位补充需求：招聘3人，要求3年以上经验，熟悉Spring Boot、MySQL、Redis，王工负责",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    assert(jobRequirementResult.job.id === registeredJob.id, "岗位需求录入应更新已注册岗位，而不是创建新岗位");
    steps.push({
      name: "岗位需求录入",
      detail: {
        jobId: jobRequirementResult.job.id,
        sameJobUpdated: jobRequirementResult.job.id === registeredJob.id,
        targetHeadcount: jobRequirementResult.job.targetHeadcount,
        requirementsCount: jobRequirementResult.job.requirements.length
      }
    });

    const candidateIngest = await postJson<{ candidate: Candidate; replyText: string }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，简历不错，王工跟进，手机号13800138000",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    const originalCandidateId = candidateIngest.candidate.id;
    let candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(candidates.length === 1, `录入候选人后应只有1个候选人，实际${candidates.length}`);
    steps.push({
      name: "录入候选人",
      detail: {
        candidateId: originalCandidateId,
        candidateCount: candidates.length,
        name: candidateIngest.candidate.name,
        position: candidateIngest.candidate.position,
        stage: candidateIngest.candidate.stage
      }
    });

    const feedback = await postJson<{ candidate: Candidate; replyText: string }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 张三一面不错，表达能力清晰，建议安排二面，王工继续跟进",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(feedback.candidate.id === originalCandidateId, "面试反馈应更新原候选人ID，不能创建新候选人");
    assert(candidates.length === 1, `面试反馈后应仍然只有1个候选人，实际${candidates.length}`);
    assert(candidates[0].summary.includes("表达能力清晰"), "候选人AI总结应包含最新面试反馈");
    steps.push({
      name: "面试反馈更新",
      detail: {
        sameCandidateUpdated: feedback.candidate.id === originalCandidateId,
        candidateCount: candidates.length,
        stage: feedback.candidate.stage,
        summary: candidates[0].summary
      }
    });

    const candidateQuery = await postJson<{ candidate: Candidate; replyText: string }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 查一下张三进展",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(candidateQuery.candidate.id === originalCandidateId, "候选人查询应返回原候选人");
    assert(candidates.length === 1, `候选人查询后不应创建候选人，实际${candidates.length}`);
    steps.push({
      name: "候选人查询",
      detail: {
        queriedCandidateId: candidateQuery.candidate.id,
        sameCandidateReturned: candidateQuery.candidate.id === originalCandidateId,
        candidateCount: candidates.length,
        replyText: candidateQuery.replyText
      }
    });

    const progressQuery = await postJson<{ progress: JobProgress; replyText: string }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 Java后端现在进度怎么样",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(progressQuery.progress.job?.id === registeredJob.id, "岗位进度查询应命中已注册Java后端岗位");
    assert(progressQuery.progress.totalCandidates === 1, "岗位进度查询应统计1个张三");
    assert(candidates.length === 1, `岗位进度查询后不应创建候选人，实际${candidates.length}`);
    steps.push({
      name: "岗位进度查询",
      detail: {
        jobId: progressQuery.progress.job?.id,
        totalCandidates: progressQuery.progress.totalCandidates,
        effectiveCandidates: progressQuery.progress.effectiveCandidates,
        candidateCount: candidates.length,
        replyText: progressQuery.replyText
      }
    });

    const reject = await postJson<{ candidate: Candidate; replyText: string }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 张三沟通后不合适，淘汰，王工记录原因",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    candidates = await getJson<Candidate[]>(baseUrl, "/api/candidates");
    assert(reject.candidate.id === originalCandidateId, "淘汰消息应更新原候选人ID，不能创建新候选人");
    assert(candidates.length === 1, `淘汰后应仍然只有1个候选人，实际${candidates.length}`);
    assert(candidates[0].stage === "rejected", `淘汰后阶段应为rejected，实际${candidates[0].stage}`);
    steps.push({
      name: "淘汰状态更新",
      detail: {
        sameCandidateUpdated: reject.candidate.id === originalCandidateId,
        candidateCount: candidates.length,
        stage: candidates[0].stage,
        risks: candidates[0].risks,
        timelineCount: candidates[0].timeline.length
      }
    });

    const finalProgress = await postJson<{ progress: JobProgress }>(baseUrl, "/api/messages/simulate", {
      content: "@招聘助手 Java后端进度查询",
      sender: "测试HR",
      groupName: "招聘内部协作群"
    });
    assert(finalProgress.progress.totalCandidates === 1, "淘汰后岗位总候选人仍应是1个张三");
    assert(finalProgress.progress.stageCounts.rejected === 1, "淘汰后岗位漏斗 rejected 应为1");
    steps.push({
      name: "淘汰后进度复查",
      detail: {
        totalCandidates: finalProgress.progress.totalCandidates,
        effectiveCandidates: finalProgress.progress.effectiveCandidates,
        rejected: finalProgress.progress.stageCounts.rejected
      }
    });

    console.log("招聘链路端到端测试通过。");
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
  console.error("招聘链路端到端测试失败：");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

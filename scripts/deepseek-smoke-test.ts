import type { Candidate, JobProgress, JobRequirement, RecruitmentStage } from "../src/shared/types";
import { OpenAiCompatibleExtractor } from "../src/server/ai/AiExtractor";
import { config } from "../src/server/config";

type SmokeResult = {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: unknown;
};

const extractor = new OpenAiCompatibleExtractor(config.ai);

const now = new Date().toISOString();

const sampleJob: JobRequirement = {
  id: "smoke-job-java-backend",
  title: "Java后端",
  targetHeadcount: 3,
  owner: "王工",
  requirements: ["3年以上Java后端经验", "熟悉Spring Boot和微服务", "有高并发或交易系统经验优先"],
  supplements: ["需要能独立负责核心服务开发，重视稳定性和协作沟通"],
  status: "open",
  createdAt: now,
  updatedAt: now
};

const sampleResumeText = [
  "张三，手机号13800138000，5年Java后端开发经验。",
  "曾负责支付交易系统和会员中心，熟悉Spring Boot、MySQL、Redis、消息队列和微服务治理。",
  "参与过高并发接口优化，推动过核心链路稳定性治理，有跨团队沟通经验。"
].join("\n");

const emptyStageCounts = (): Record<RecruitmentStage, number> => ({
  new: 1,
  screening: 1,
  interview_scheduled: 0,
  interviewing: 0,
  offer: 0,
  rejected: 0,
  withdrawn: 0,
  manual_review: 0
});

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

async function runStep(name: string, fn: () => Promise<unknown>): Promise<SmokeResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (error) {
    return { name, ok: false, error: sanitizeError(error) };
  }
}

async function main() {
  if (!config.ai.baseUrl || !config.ai.apiKey) {
    throw new Error("请先在 .env 中配置 OPENAI_BASE_URL 和 OPENAI_API_KEY。");
  }

  console.log(`DeepSeek smoke test: baseUrl=${config.ai.baseUrl}, model=${config.ai.model}, apiKey=已配置`);

  let extractedCandidate: Candidate | undefined;

  const results: SmokeResult[] = [];

  results.push(
    await runStep("任务分类 classifyTask", async () => {
      const result = await extractor.classifyTask({
        content: "@招聘助手 Java后端岗位招3人，王工负责，要求3年以上经验，熟悉Spring Boot",
        kind: "text",
        sender: "测试HR",
        groupName: "招聘测试群"
      });
      return {
        type: result.type,
        confidence: result.confidence,
        jobTitle: result.jobTitle
      };
    })
  );

  results.push(
    await runStep("候选人/简历抽取 extract", async () => {
      const extraction = await extractor.extract(`目标岗位：Java后端\n${sampleResumeText}`, {
        sender: "测试HR",
        groupName: "招聘测试群"
      });
      extractedCandidate = {
        id: "smoke-candidate-zhangsan",
        name: extraction.candidateName,
        phone: extraction.phone,
        position: "Java后端",
        stage: extraction.stage,
        owner: extraction.owner,
        sourceGroup: extraction.sourceGroup,
        interviewTime: extraction.interviewTime,
        summary: extraction.summary,
        risks: extraction.risks,
        nextAction: extraction.nextAction,
        confidence: extraction.confidence,
        createdAt: now,
        updatedAt: now,
        timeline: []
      };
      return {
        candidateName: extraction.candidateName,
        position: extraction.position,
        stage: extraction.stage,
        confidence: extraction.confidence
      };
    })
  );

  results.push(
    await runStep("岗位需求解析 parseJobRequirement", async () => {
      const result = await extractor.parseJobRequirement(
        "@招聘助手 Java后端岗位招3人，王工负责，要求3年以上经验，熟悉Spring Boot和微服务，有高并发经验优先"
      );
      return {
        title: result.title,
        targetHeadcount: result.targetHeadcount,
        owner: result.owner,
        requirementsCount: result.requirements.length
      };
    })
  );

  results.push(
    await runStep("简历匹配评估 evaluateResume", async () => {
      const candidate =
        extractedCandidate ?? {
          id: "smoke-candidate-zhangsan",
          name: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: "screening" as const,
          summary: "5年Java后端候选人，熟悉微服务和高并发系统。",
          risks: [],
          nextAction: "安排技术面试",
          confidence: 0.9,
          createdAt: now,
          updatedAt: now,
          timeline: []
        };
      const result = await extractor.evaluateResume({
        resumeText: sampleResumeText,
        candidate: {
          candidateName: candidate.name,
          phone: candidate.phone,
          position: candidate.position,
          stage: candidate.stage,
          owner: candidate.owner,
          sourceGroup: candidate.sourceGroup,
          interviewTime: candidate.interviewTime,
          summary: candidate.summary,
          risks: candidate.risks,
          nextAction: candidate.nextAction,
          confidence: candidate.confidence
        },
        jobTitle: sampleJob.title,
        job: sampleJob
      });
      extractedCandidate = {
        ...candidate,
        matchScore: result.matchScore,
        evaluation: result
      };
      return {
        matchScore: result.matchScore,
        recommendation: result.recommendation,
        technical: result.abilityAssessment.technical,
        summary: result.summary
      };
    })
  );

  results.push(
    await runStep("JD生成 generateJd", async () => {
      const jd = await extractor.generateJd(sampleJob);
      return {
        length: jd.length,
        preview: jd.slice(0, 160)
      };
    })
  );

  results.push(
    await runStep("岗位进度总结 summarizeJobProgress", async () => {
      const candidate =
        extractedCandidate ?? {
          id: "smoke-candidate-zhangsan",
          name: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: "screening" as const,
          summary: "5年Java后端候选人，熟悉微服务和高并发系统。",
          risks: [],
          nextAction: "安排技术面试",
          confidence: 0.9,
          createdAt: now,
          updatedAt: now,
          timeline: []
        };
      const progress: JobProgress = {
        job: sampleJob,
        title: sampleJob.title,
        targetHeadcount: sampleJob.targetHeadcount,
        totalCandidates: 2,
        effectiveCandidates: 2,
        offerCandidates: 0,
        gap: 1,
        stageCounts: emptyStageCounts(),
        candidates: [candidate],
        keyCandidates: [
          {
            candidate,
            priorityScore: 82,
            reasons: ["匹配度高", "阶段可推进"]
          }
        ],
        riskCandidates: [],
        summary: "Java后端：目标3人，有效候选2人，Offer 0人，风险候选0人，缺口1人。"
      };
      const summary = await extractor.summarizeJobProgress(progress);
      return { summary };
    })
  );

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${result.name}`);
    console.log(JSON.stringify(result.ok ? result.detail : result.error, null, 2));
  }

  if (failed.length) {
    console.error(`\nDeepSeek smoke test failed: ${failed.length}/${results.length} failed.`);
    process.exit(1);
  }

  console.log(`\nDeepSeek smoke test passed: ${results.length}/${results.length} passed.`);
}

void main().catch((error) => {
  console.error(JSON.stringify(sanitizeError(error), null, 2));
  process.exit(1);
});

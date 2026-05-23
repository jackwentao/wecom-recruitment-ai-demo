import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecruitmentAi } from "../ai/AiExtractor";
import { RuleBasedFallbackExtractor } from "../ai/AiExtractor";
import { CandidateRepository } from "../repositories/CandidateRepository";
import { RecruitmentMessageService } from "./RecruitmentMessageService";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

function mockAi(
  extract: RecruitmentAi["extract"],
  classifyTask: RecruitmentAi["classifyTask"] = () =>
    Promise.resolve({ type: "interview_feedback", confidence: 0.9, candidateName: "张三" })
): RecruitmentAi {
  const baseAi = new RuleBasedFallbackExtractor();
  return {
    ...baseAi,
    extract,
    classifyTask,
    parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
    evaluateResume: (input) => baseAi.evaluateResume(input),
    generateJd: (inputJob) => baseAi.generateJd(inputJob),
    summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
  };
}

describe("RecruitmentMessageService", () => {
  it("二面反馈没有历史候选人时不会新建候选人，会生成候选人确认任务", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "Java后端" });
    const service = new RecruitmentMessageService(
      repository,
      mockAi(async () => ({
        candidateName: "张三",
        position: "Java后端",
        stage: "interviewing",
        owner: "王工",
        summary: "张三表现不错，可以安排二面。",
        risks: [],
        nextAction: "安排二面",
        confidence: 0.9
      }))
    );

    const result = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三表现不错，可以二面，王工跟进"
    });
    const candidates = await repository.listCandidates({});
    const pendingTasks = await repository.listPendingTasks();

    expect(result.message.status).toBe("needs_review");
    expect(result.pendingTask?.context.action).toBe("confirm_candidate_for_mutation");
    expect(result.replyText).toContain("没有找到候选人张三");
    expect(candidates).toHaveLength(0);
    expect(pendingTasks).toHaveLength(1);
  });

  it("明确进入一面时允许新建候选人", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "Java后端" });
    const service = new RecruitmentMessageService(
      repository,
      mockAi(
        async () => ({
          candidateName: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: "interview_scheduled",
          owner: "王工",
          interviewTime: "2026-05-23T15:00:00+08:00",
          summary: "张三 Java后端候选人，5月23日下午3点一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9
        }),
        () => Promise.resolve({ type: "schedule_update", confidence: 0.9, candidateName: "张三", jobTitle: "Java后端" })
      )
    );

    const result = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三 Java后端候选人，5月23日下午3点一面，王工跟进，手机号13800138000"
    });

    expect(result.message.status).toBe("parsed");
    expect(result.candidate?.jobId).toBe(job.id);
    expect(result.candidate?.stage).toBe("interview_scheduled");
    expect(result.replyText).toContain("已记录候选人张三");
  });

  it("二面反馈命中多个同名候选人时不会自动更新，会要求选择候选人", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const javaJob = await repository.upsertJobRequirement({ title: "Java后端" });
    const goJob = await repository.upsertJobRequirement({ title: "Go后端" });
    const now = new Date().toISOString();
    await repository.save({
      messages: [],
      tasks: [],
      pendingTasks: [],
      jobs: [goJob, javaJob],
      candidates: [
        {
          id: "candidate-java",
          name: "张三",
          jobId: javaJob.id,
          position: "Java后端",
          stage: "interview_scheduled",
          owner: "王工",
          summary: "张三 Java后端候选人，已安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9,
          createdAt: now,
          updatedAt: now,
          timeline: []
        },
        {
          id: "candidate-go",
          name: "张三",
          jobId: goJob.id,
          position: "Go后端",
          stage: "interview_scheduled",
          owner: "赵工",
          summary: "张三 Go后端候选人，已安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9,
          createdAt: now,
          updatedAt: now,
          timeline: []
        }
      ]
    });
    const service = new RecruitmentMessageService(
      repository,
      mockAi(async () => ({
        candidateName: "张三",
        position: "待确认岗位",
        stage: "interviewing",
        owner: "李工",
        summary: "张三一面反馈不错，安排二面。",
        risks: [],
        nextAction: "安排二面",
        confidence: 0.9
      }))
    );

    const result = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三一面反馈不错，安排二面，李工跟进"
    });
    const candidates = await repository.listCandidates({});

    expect(result.message.status).toBe("needs_review");
    expect(result.pendingTask?.context.action).toBe("confirm_candidate_for_mutation");
    expect(result.replyText).toContain("找到多个张三");
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.stage === "interview_scheduled")).toBe(true);
  });

  it("回复候选人确认任务后只更新指定候选人，不新建候选人", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const javaJob = await repository.upsertJobRequirement({ title: "Java后端" });
    const goJob = await repository.upsertJobRequirement({ title: "Go后端" });
    const now = new Date().toISOString();
    await repository.save({
      messages: [],
      tasks: [],
      pendingTasks: [],
      jobs: [goJob, javaJob],
      candidates: [
        {
          id: "candidate-java",
          name: "张三",
          jobId: javaJob.id,
          position: "Java后端",
          stage: "interview_scheduled",
          owner: "王工",
          summary: "张三 Java后端候选人，已安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9,
          createdAt: now,
          updatedAt: now,
          timeline: []
        },
        {
          id: "candidate-go",
          name: "张三",
          jobId: goJob.id,
          position: "Go后端",
          stage: "interview_scheduled",
          owner: "赵工",
          summary: "张三 Go后端候选人，已安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9,
          createdAt: now,
          updatedAt: now,
          timeline: []
        }
      ]
    });
    const service = new RecruitmentMessageService(
      repository,
      mockAi(async () => ({
        candidateName: "张三",
        position: "待确认岗位",
        stage: "interviewing",
        owner: "李工",
        summary: "张三一面反馈不错，安排二面。",
        risks: [],
        nextAction: "安排二面",
        confidence: 0.9
      }))
    );

    const pending = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三一面反馈不错，安排二面，李工跟进"
    });
    const resolved = await service.process({
      source: "local_simulator",
      content: `${pending.pendingTask?.id} 选2`
    });
    const candidates = await repository.listCandidates({});
    const tasks = await repository.listPendingTasks();
    const goCandidate = candidates.find((candidate) => candidate.jobId === goJob.id);
    const javaCandidate = candidates.find((candidate) => candidate.jobId === javaJob.id);

    expect(resolved.message.status).toBe("parsed");
    expect(candidates).toHaveLength(2);
    expect(goCandidate?.stage).toBe("interviewing");
    expect(goCandidate?.owner).toBe("李工");
    expect(javaCandidate?.stage).toBe("interview_scheduled");
    expect(tasks[0].status).toBe("resolved");
  });

  it("待确认候选人不会直接入库", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "Java后端" });
    const service = new RecruitmentMessageService(
      repository,
      mockAi(
        async () => ({
          candidateName: "待确认候选人",
          position: "Java后端",
          stage: "screening",
          owner: "王工",
          summary: "Java后端候选人不错。",
          risks: [],
          nextAction: "确认候选人姓名",
          confidence: 0.55
        }),
        () => Promise.resolve({ type: "resume_parse_match", confidence: 0.8, jobTitle: "Java后端" })
      )
    );

    const result = await service.process({
      source: "local_simulator",
      content: "@招聘助手 Java后端候选人不错，王工跟进"
    });
    const candidates = await repository.listCandidates({});

    expect(result.message.status).toBe("needs_review");
    expect(result.pendingTask?.context.action).toBe("confirm_candidate_for_mutation");
    expect(candidates).toHaveLength(0);
  });

  it("同一候选人的多条消息会合并到同一候选人时间线", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "Java后端" });
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract(message) {
        return {
          candidateName: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: message.includes("二面") ? "interviewing" : "interview_scheduled",
          owner: "王工",
          summary: message,
          risks: [],
          nextAction: "王工继续跟进",
          confidence: 0.9
        };
      },
      classifyTask: (input) => baseAi.classifyTask(input),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (job) => baseAi.generateJd(job),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const first = await service.process({
      source: "local_simulator",
      content: "张三 Java后端 明天下午一面"
    });
    const second = await service.process({
      source: "local_simulator",
      content: "张三 Java后端 二面反馈不错"
    });
    const candidates = await repository.listCandidates({});

    expect(candidates).toHaveLength(1);
    expect(first.candidate?.id).toBe(second.candidate?.id);
    expect(candidates[0].stage).toBe("interviewing");
    expect(candidates[0].timeline).toHaveLength(2);
  });

  it("候选人状态更新未提岗位时会更新同名唯一候选人的AI总结", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "AI agent" });
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract(message) {
        if (message.includes("进入初筛")) {
          return {
            candidateName: "于文涛",
            position: "待确认岗位",
            stage: "screening",
            owner: "王琳",
            summary: "于文涛进入初筛，表达能力清晰，王琳负责。",
            risks: [],
            nextAction: "王琳继续推进初筛",
            confidence: 0.86
          };
        }
        return {
          candidateName: "于文涛",
          phone: "17068236666",
          position: "AI agent",
          stage: "new",
          owner: "待确认负责人",
          summary: "于文涛投递AI agent岗位。",
          risks: [],
          nextAction: "确认负责人",
          confidence: 0.9
        };
      },
      classifyTask: () => Promise.resolve({ type: "resume_parse_match", confidence: 0.9, candidateName: "于文涛" }),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (inputJob) => baseAi.generateJd(inputJob),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    await service.process({
      source: "local_simulator",
      content: "@招聘助手 于文涛 AI agent候选人，手机号17068236666"
    });
    const updated = await service.process({
      source: "local_simulator",
      content: "@招聘助手 于文涛进入初筛，表达能力清晰，王琳负责"
    });
    const candidates = await repository.listCandidates({});
    const messages = (await repository.all()).messages;

    expect(updated.message.status).toBe("parsed");
    expect(updated.candidate?.id).toBe(candidates[0].id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].jobId).toBe(job.id);
    expect(candidates[0].position).toBe("AI agent");
    expect(candidates[0].stage).toBe("screening");
    expect(candidates[0].owner).toBe("王琳");
    expect(candidates[0].summary).toContain("表达能力清晰");
    expect(candidates[0].summary).toContain("投递AI agent岗位");
    expect(candidates[0].timeline).toHaveLength(2);
    expect(messages[0].replyText).toContain("已更新候选人于文涛");
  });

  it("面试反馈命中多个同名候选人时会优先更新已有岗位记录，不再新建待确认候选人", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "Java后端" });
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract(message) {
        if (message.includes("反馈通过")) {
          return {
            candidateName: "张三",
            position: "待确认岗位",
            stage: "interviewing",
            owner: "王工",
            summary: "张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面。",
            risks: ["微服务项目深度一般"],
            nextAction: "安排二面",
            confidence: 0.88
          };
        }
        return {
          candidateName: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: "interview_scheduled",
          owner: "王工",
          summary: "张三应聘Java后端，安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9
        };
      },
      classifyTask: () => Promise.resolve({ type: "interview_feedback", confidence: 0.9, candidateName: "张三" }),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (inputJob) => baseAi.generateJd(inputJob),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const original = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进，手机号13800138000"
    });
    await repository.upsertCandidate(
      {
        id: "duplicate-message",
        source: "local_simulator",
        kind: "text",
        taskType: "resume_parse_match",
        content: "历史误入库：张三 待确认岗位",
        receivedAt: new Date().toISOString(),
        status: "received"
      },
      {
        candidateName: "张三",
        position: "待确认岗位",
        stage: "new",
        summary: "历史误入库：张三 待确认岗位",
        risks: [],
        nextAction: "待确认岗位",
        confidence: 0.55
      }
    );

    const updated = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面，王工继续跟进"
    });
    const candidates = await repository.listCandidates({});

    expect(candidates).toHaveLength(1);
    expect(updated.candidate?.id).toBe(original.candidate?.id);
    expect(updated.candidate?.jobId).toBe(job.id);
    expect(updated.candidate?.position).toBe("Java后端");
    expect(updated.candidate?.stage).toBe("interviewing");
    expect(updated.candidate?.timeline).toHaveLength(3);
    expect(updated.replyText).toContain("已更新候选人张三");
  });

  it("LLM把面试轮次误抽进姓名时会先搜索已有候选人并归一为原姓名", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "Java后端" });
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract(message) {
        if (message.includes("一面反馈")) {
          return {
            candidateName: "张三一面",
            position: "待确认岗位",
            stage: "interviewing",
            owner: "王工继续",
            summary: "张三一面反馈通过，Java基础扎实，安排二面。",
            risks: [],
            nextAction: "王工继续跟进张三一面",
            confidence: 0.55
          };
        }
        return {
          candidateName: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: "interview_scheduled",
          owner: "王工",
          summary: "张三应聘Java后端，安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9
        };
      },
      classifyTask: () => Promise.resolve({ type: "interview_feedback", confidence: 0.9, candidateName: "张三一面" }),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (inputJob) => baseAi.generateJd(inputJob),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const original = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进，手机号13800138000"
    });
    const updated = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三一面反馈通过，Java基础扎实，安排二面，王工继续跟进"
    });
    const candidates = await repository.listCandidates({});

    expect(candidates).toHaveLength(1);
    expect(updated.candidate?.id).toBe(original.candidate?.id);
    expect(updated.candidate?.name).toBe("张三");
    expect(updated.candidate?.jobId).toBe(job.id);
    expect(updated.candidate?.position).toBe("Java后端");
    expect(updated.candidate?.stage).toBe("interviewing");
    expect(candidates[0].timeline).toHaveLength(2);
  });

  it("负责人字段会清洗掉继续跟进等动作词", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "Java后端" });
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract(message) {
        if (message.includes("一面反馈")) {
          return {
            candidateName: "张三",
            position: "Java开发",
            stage: "interviewing",
            owner: "王工继续",
            summary: "张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面。",
            risks: ["微服务项目深度一般"],
            nextAction: "请王工继续跟进张三二面",
            confidence: 0.82
          };
        }
        return {
          candidateName: "张三",
          phone: "13800138000",
          position: "Java后端",
          stage: "interview_scheduled",
          owner: "王工",
          summary: "张三应聘Java后端，已安排一面。",
          risks: [],
          nextAction: "等待一面反馈",
          confidence: 0.9
        };
      },
      classifyTask: () => Promise.resolve({ type: "interview_feedback", confidence: 0.9, candidateName: "张三" }),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (inputJob) => baseAi.generateJd(inputJob),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const original = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进，手机号13800138000"
    });
    const updated = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面，王工继续跟进"
    });
    const candidates = await repository.listCandidates({});

    expect(updated.candidate?.id).toBe(original.candidate?.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].jobId).toBe(job.id);
    expect(candidates[0].position).toBe("Java后端");
    expect(candidates[0].owner).toBe("王工");
    expect(updated.replyText).toContain("负责人：王工");
    expect(updated.replyText).not.toContain("负责人：王工继续");
  });

  it("更新类消息不会把Java基础等技能词脑补成新岗位", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "Java后端" });
    await repository.upsertCandidate(
      {
        id: "old-candidate-message",
        source: "local_simulator",
        kind: "text",
        taskType: "resume_parse_match",
        content: "张三 Java后端候选人，王工跟进",
        receivedAt: new Date().toISOString(),
        status: "received"
      },
      {
        candidateName: "张三",
        position: "Java后端",
        stage: "interview_scheduled",
        owner: "王工",
        summary: "张三应聘Java后端，已安排一面。",
        risks: [],
        nextAction: "等待一面反馈",
        confidence: 0.9
      }
    );
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract() {
        return {
          candidateName: "张三",
          position: "Java开发",
          stage: "interviewing",
          owner: "王工继续",
          summary: "张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面。",
          risks: ["微服务项目深度一般"],
          nextAction: "安排二面",
          confidence: 0.82
        };
      },
      classifyTask: () => Promise.resolve({ type: "interview_feedback", confidence: 0.9, candidateName: "张三" }),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (inputJob) => baseAi.generateJd(inputJob),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const updated = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面，王工继续跟进"
    });
    const candidates = await repository.listCandidates({});

    expect(candidates).toHaveLength(1);
    expect(updated.candidate?.id).toBe(candidates[0].id);
    expect(candidates[0].jobId).toBe(job.id);
    expect(candidates[0].position).toBe("Java后端");
    expect(candidates[0].stage).toBe("interviewing");
    expect(candidates[0].summary).toContain("Java基础扎实");
  });

  it("读取看板时会把历史脑补岗位的同名重复候选人合并回岗位库中的岗位", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "Java后端" });
    await repository.upsertCandidate(
      {
        id: "real-job-message",
        source: "local_simulator",
        kind: "text",
        taskType: "resume_parse_match",
        content: "张三 Java后端候选人，王工跟进",
        receivedAt: new Date(Date.now() - 1000).toISOString(),
        status: "received"
      },
      {
        candidateName: "张三",
        position: "Java后端",
        stage: "interview_scheduled",
        owner: "王工",
        summary: "张三应聘Java后端，已安排一面。",
        risks: [],
        nextAction: "等待一面反馈",
        confidence: 0.9
      }
    );
    await repository.upsertCandidate(
      {
        id: "hallucinated-job-message",
        source: "local_simulator",
        kind: "text",
        taskType: "interview_feedback",
        content: "张三一面反馈通过，Java基础扎实，安排二面",
        receivedAt: new Date().toISOString(),
        status: "received"
      },
      {
        candidateName: "张三",
        position: "Java开发",
        stage: "interviewing",
        owner: "王工",
        summary: "张三一面反馈通过，Java基础扎实，安排二面。",
        risks: [],
        nextAction: "安排二面",
        confidence: 0.8
      }
    );

    const candidates = await repository.listCandidates({});

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("张三");
    expect(candidates[0].position).toBe("Java后端");
    expect(candidates[0].stage).toBe("interviewing");
    expect(candidates[0].timeline).toHaveLength(2);
  });

  it("历史数据中只有带面试轮次的姓名时读取看板会清洗为候选人真实姓名", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertCandidate(
      {
        id: "message-with-bad-name",
        source: "local_simulator",
        kind: "text",
        taskType: "interview_feedback",
        content: "张三一面反馈通过",
        receivedAt: new Date().toISOString(),
        status: "received"
      },
      {
        candidateName: "张三一面",
        position: "Java后端",
        stage: "interviewing",
        owner: "王工",
        summary: "张三一面反馈通过",
        risks: [],
        nextAction: "安排二面",
        confidence: 0.6
      }
    );

    const candidates = await repository.listCandidates({});

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("张三");
    expect(candidates[0].position).toBe("Java后端");
  });

  it("岗位需求解析和JD生成会走LLM层", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      extract: (message, context) => baseAi.extract(message, context),
      async classifyTask() {
        return { type: "job_requirement", confidence: 0.95, jobTitle: "算法工程师" };
      },
      async parseJobRequirement() {
        return {
          title: "算法工程师",
          targetHeadcount: 2,
          owner: "李工",
          requirements: ["推荐系统经验", "熟悉Python"],
          supplement: "LLM解析补充"
        };
      },
      async generateJd(job) {
        return `# ${job.title} JD\n\nLLM生成JD`;
      },
      evaluateResume: (input) => baseAi.evaluateResume(input),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const result = await service.process({
      source: "local_simulator",
      content: "@招聘助手 算法岗位招2人，李工负责"
    });
    const jd = await service.generateJdForJob(result.job!);

    expect(result.job?.title).toBe("算法工程师");
    expect(result.job?.targetHeadcount).toBe(2);
    expect(jd).toContain("LLM生成JD");
  });

  it("PDF简历消息没有目标岗位时会进入待确认", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());

    const result = await service.process({
      source: "local_simulator",
      kind: "resume_pdf",
      content: "李梅 产品经理候选人，周五上午10点业务面，赵婷负责",
      attachment: {
        fileName: "李梅简历.pdf",
        extractedText: "李梅 产品经理候选人，周五上午10点业务面，赵婷负责"
      }
    });

    const pendingTasks = await repository.listPendingTasks();
    const candidates = await repository.listCandidates({});

    expect(result.message.status).toBe("needs_review");
    expect(result.pendingTask?.prompt).toContain("岗位ID");
    expect(pendingTasks).toHaveLength(1);
    expect(candidates).toHaveLength(0);
  });

  it("PDF简历消息会使用随文件指定的目标岗位", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "高级产品经理" });
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());

    const result = await service.process({
      source: "local_simulator",
      kind: "resume_pdf",
      content: "李梅 产品经理候选人，周五上午10点业务面，赵婷负责",
      attachment: {
        fileName: "李梅简历.pdf",
        jobTitle: "高级产品经理",
        extractedText: "李梅 产品经理候选人，周五上午10点业务面，赵婷负责"
      }
    });

    expect(result.message.status).toBe("parsed");
    expect(result.candidate?.matchScore).toBeGreaterThan(0);
    expect(result.candidate?.evaluation?.matchScore).toBe(result.candidate?.matchScore);
    expect(result.candidate?.position).toBe("高级产品经理");
  });

  it("候选人岗位不存在时会生成任务ID，回复岗位ID后继续原任务", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "高级Java后端" });
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());

    const pending = await service.process({
      source: "local_simulator",
      content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进，手机号13800138000"
    });
    const candidatesBeforeConfirm = await repository.listCandidates({});

    expect(pending.message.status).toBe("needs_review");
    expect(pending.pendingTask?.prompt).toContain("岗位库中不存在");
    expect(pending.replyText).toContain(job.id);
    expect(candidatesBeforeConfirm).toHaveLength(0);

    const resolved = await service.process({
      source: "local_simulator",
      content: `${pending.pendingTask?.id} ${job.id}`
    });
    const candidates = await repository.listCandidates({});
    const tasks = await repository.listPendingTasks();

    expect(resolved.message.status).toBe("parsed");
    expect(resolved.candidate?.name).toBe("张三");
    expect(resolved.candidate?.jobId).toBe(job.id);
    expect(resolved.candidate?.position).toBe("高级Java后端");
    expect(candidates).toHaveLength(1);
    expect(tasks[0].status).toBe("resolved");
  });

  it("PDF简历解析会保存学校、实习、项目和工作经验画像", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    await repository.upsertJobRequirement({ title: "Java后端" });
    const baseAi = new RuleBasedFallbackExtractor();
    const ai: RecruitmentAi = {
      ...baseAi,
      async extract() {
        return {
          candidateName: "于文涛",
          phone: "17068236666",
          position: "Java后端",
          stage: "new",
          summary: "于文涛投递Java后端岗位",
          risks: [],
          nextAction: "进行简历筛选",
          confidence: 0.9,
          resumeProfile: {
            email: "3079971388@qq.com",
            location: "吉林长春",
            birthDate: "2002.05",
            workYears: "实习经验",
            education: [{ school: "长春工业大学", degree: "本科", major: "软件工程", period: "2020-2024", educationLevel: "本科" }],
            internships: [{ company: "某科技公司", role: "Java开发实习生", period: "2023.06-2023.09", description: "参与接口开发", highlights: ["完成用户模块接口"] }],
            workExperiences: [{ company: "某软件公司", role: "后端开发", period: "2024.01-2024.03", description: "参与业务系统开发", highlights: ["负责数据查询优化"] }],
            projects: [{ name: "校园招聘系统", role: "后端开发", period: "2023", description: "负责候选人模块", techStack: ["Java", "Spring Boot", "MySQL"], highlights: ["完成简历管理功能"] }],
            skills: ["Java", "Spring Boot", "MySQL"],
            certificates: ["英语四级"],
            languages: [],
            rawHighlights: ["熟悉Java后端开发"]
          }
        };
      },
      classifyTask: () => Promise.resolve({ type: "resume_parse_match", confidence: 0.95, jobTitle: "Java后端" }),
      parseJobRequirement: (content) => baseAi.parseJobRequirement(content),
      evaluateResume: (input) => baseAi.evaluateResume(input),
      generateJd: (job) => baseAi.generateJd(job),
      summarizeJobProgress: (progress) => baseAi.summarizeJobProgress(progress)
    };
    const service = new RecruitmentMessageService(repository, ai);

    const result = await service.process({
      source: "local_simulator",
      kind: "resume_pdf",
      content: "姓名：于文涛|电话：17068236666",
      attachment: {
        fileName: "于文涛简历.pdf",
        jobTitle: "Java后端",
        extractedText: "姓名：于文涛|电话：17068236666\n教育经历：长春工业大学 软件工程\n项目经历：校园招聘系统"
      }
    });
    const candidates = await repository.listCandidates({});

    expect(result.candidate?.resumeProfile?.education[0]?.school).toBe("长春工业大学");
    expect(result.candidate?.resumeProfile?.internships[0]?.role).toBe("Java开发实习生");
    expect(result.candidate?.resumeProfile?.workExperiences[0]?.company).toBe("某软件公司");
    expect(result.candidate?.resumeProfile?.projects[0]?.techStack).toContain("Spring Boot");
    expect(candidates[0].resumeProfile?.skills).toContain("Java");
  });

  it("LLM失败时ResilientAiExtractor会回退到规则层", async () => {
    const failingAi: RecruitmentAi = {
      async extract() {
        throw new Error("boom");
      },
      async classifyTask() {
        throw new Error("boom");
      },
      async parseJobRequirement() {
        throw new Error("boom");
      },
      async evaluateResume() {
        throw new Error("boom");
      },
      async generateJd() {
        throw new Error("boom");
      },
      async summarizeJobProgress() {
        throw new Error("boom");
      }
    };
    const { ResilientAiExtractor } = await import("../ai/AiExtractor");
    const ai = new ResilientAiExtractor(failingAi, new RuleBasedFallbackExtractor());

    const classified = await ai.classifyTask({
      content: "@招聘助手 Java后端岗位招3人，王工负责",
      kind: "text"
    });
    const job = await ai.parseJobRequirement("@招聘助手 Java后端岗位招3人，王工负责");

    const evaluation = await ai.evaluateResume({
      resumeText: "Java backend 5 years",
      candidate: {
        candidateName: "张三",
        position: "Java后端",
        stage: "screening",
        summary: "Java后端候选人",
        risks: [],
        nextAction: "安排面试",
        confidence: 0.8
      },
      jobTitle: "Java后端"
    });

    expect(classified.type).toBe("job_requirement");
    expect(job.title).toContain("Java");
    expect(job.targetHeadcount).toBe(3);
    expect(evaluation.matchScore).toBeGreaterThan(0);
  });

  it("PDF简历待确认任务补充岗位后会自动继续解析入库", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-demo-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job = await repository.upsertJobRequirement({ title: "高级产品经理" });
    const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());

    const pending = await service.process({
      source: "local_simulator",
      kind: "resume_pdf",
      content: "李梅 产品经理候选人，周五上午10点业务面，赵婷负责",
      attachment: {
        fileName: "李梅简历.pdf",
        extractedText: "李梅 产品经理候选人，周五上午10点业务面，赵婷负责"
      }
    });
    const taskId = pending.pendingTask?.id;
    expect(taskId).toBeTruthy();

    const resolved = await service.process({
      source: "local_simulator",
      content: `${taskId} ${job.id}`
    });
    const candidates = await repository.listCandidates({});
    const tasks = await repository.listPendingTasks();

    expect(resolved.message.status).toBe("parsed");
    expect(resolved.candidate?.name).toBe("李梅");
    expect(resolved.candidate?.position).toBe("高级产品经理");
    expect(resolved.candidate?.matchScore).toBeGreaterThan(0);
    expect(candidates).toHaveLength(1);
    expect(tasks[0].status).toBe("resolved");
  });
});

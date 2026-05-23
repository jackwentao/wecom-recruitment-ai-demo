import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Candidate, ExtractedRecruitmentInfo, JobRequirement, RawRecruitmentMessage } from "../../shared/types";
import { CandidateRepository } from "./CandidateRepository";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

const now = "2026-05-22T07:00:00.000Z";

function buildCandidate(patch: Partial<Candidate>): Candidate {
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

function buildMessage(patch: Partial<RawRecruitmentMessage>): RawRecruitmentMessage {
  return {
    id: patch.id ?? "message-id",
    source: patch.source ?? "local_simulator",
    kind: patch.kind ?? "text",
    taskType: patch.taskType ?? "interview_feedback",
    content: patch.content ?? "张三面试更新",
    receivedAt: patch.receivedAt ?? now,
    status: patch.status ?? "received",
    ...patch
  };
}

function buildExtraction(patch: Partial<ExtractedRecruitmentInfo>): ExtractedRecruitmentInfo {
  return {
    candidateName: patch.candidateName ?? "张三",
    position: patch.position ?? "Java后端",
    stage: patch.stage ?? "interviewing",
    owner: patch.owner ?? "王工",
    summary: patch.summary ?? "张三面试更新",
    risks: patch.risks ?? [],
    nextAction: patch.nextAction ?? "继续跟进",
    confidence: patch.confidence ?? 0.9,
    ...patch
  };
}

describe("CandidateRepository jobProgress", () => {
  it("会返回命中岗位的候选人全集，供导出服务生成明细", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-repository-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const job: JobRequirement = {
      id: "job-java",
      title: "Java后端",
      targetHeadcount: 2,
      owner: "王工",
      requirements: [],
      supplements: [],
      status: "open",
      createdAt: now,
      updatedAt: now
    };

    await repository.save({
      messages: [],
      tasks: [],
      pendingTasks: [],
      jobs: [job],
      candidates: [
        buildCandidate({ id: "candidate-bound", name: "张三", jobId: job.id, position: "Java后端" }),
        buildCandidate({ id: "candidate-position", name: "李四", position: "Java后端", stage: "new" }),
        buildCandidate({ id: "candidate-other", name: "王五", position: "产品经理" })
      ]
    });

    const progress = await repository.jobProgress(job.id);

    expect(progress.totalCandidates).toBe(2);
    expect(progress.candidates.map((candidate) => candidate.name)).toEqual(["张三", "李四"]);
    expect(progress.stageCounts.screening).toBe(1);
    expect(progress.stageCounts.new).toBe(1);
  });
});

describe("CandidateRepository upsertCandidate 面试时间合并", () => {
  it("从一面推进到二面但没有新时间时会清空旧的一面时间", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-repository-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));

    await repository.upsertCandidate(
      buildMessage({
        id: "first-round-message",
        taskType: "schedule_update",
        content: "张三 Java后端候选人，5月23日下午3点一面，王工跟进"
      }),
      buildExtraction({
        stage: "interview_scheduled",
        summary: "张三一面安排在5月23日下午3点。",
        nextAction: "等待一面反馈",
        interviewTime: "2026-05-23T15:00:00+08:00"
      })
    );

    const updated = await repository.upsertCandidate(
      buildMessage({
        id: "second-round-message",
        content: "张三一面表现不错，安排二面，王工跟进"
      }),
      buildExtraction({
        stage: "interviewing",
        summary: "张三一面表现不错，安排二面。",
        nextAction: "安排二面"
      })
    );

    expect(updated.candidate.interviewTime).toBeUndefined();
    expect(updated.task.dueAt).toBeUndefined();
  });

  it("同一轮二面只改负责人时会保留已有二面时间", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-repository-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));

    await repository.upsertCandidate(
      buildMessage({
        id: "second-round-time-message",
        taskType: "schedule_update",
        content: "张三二面时间定在5月24日下午4点，王工跟进"
      }),
      buildExtraction({
        stage: "interviewing",
        summary: "张三二面时间定在5月24日下午4点。",
        nextAction: "等待二面反馈",
        interviewTime: "2026-05-24T16:00:00+08:00"
      })
    );

    const updated = await repository.upsertCandidate(
      buildMessage({
        id: "second-round-owner-message",
        content: "张三二面改由李工跟进"
      }),
      buildExtraction({
        stage: "interviewing",
        owner: "李工",
        summary: "张三二面改由李工跟进。",
        nextAction: "李工继续跟进二面"
      })
    );

    expect(updated.candidate.owner).toBe("李工");
    expect(updated.candidate.interviewTime).toBe("2026-05-24T16:00:00+08:00");
  });

  it("同一轮二面补充新时间时会覆盖旧二面时间", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "recruitment-repository-"));
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));

    await repository.upsertCandidate(
      buildMessage({
        id: "old-second-round-time-message",
        taskType: "schedule_update",
        content: "张三二面时间定在5月24日下午4点，王工跟进"
      }),
      buildExtraction({
        stage: "interviewing",
        summary: "张三二面时间定在5月24日下午4点。",
        nextAction: "等待二面反馈",
        interviewTime: "2026-05-24T16:00:00+08:00"
      })
    );

    const updated = await repository.upsertCandidate(
      buildMessage({
        id: "new-second-round-time-message",
        taskType: "schedule_update",
        content: "张三二面时间改到5月25日下午2点，李工跟进"
      }),
      buildExtraction({
        stage: "interviewing",
        owner: "李工",
        summary: "张三二面时间改到5月25日下午2点。",
        nextAction: "李工跟进二面",
        interviewTime: "2026-05-25T14:00:00+08:00"
      })
    );

    expect(updated.candidate.interviewTime).toBe("2026-05-25T14:00:00+08:00");
    expect(updated.task.dueAt).toBe("2026-05-25T14:00:00+08:00");
  });
});

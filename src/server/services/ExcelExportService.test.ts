import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { Candidate, JobProgress, JobRequirement } from "../../shared/types";
import { ExcelExportService } from "./ExcelExportService";

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
    nextAction: patch.nextAction ?? "安排下一轮",
    confidence: patch.confidence ?? 0.8,
    resumeProfile: patch.resumeProfile,
    matchScore: patch.matchScore,
    evaluation: patch.evaluation,
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    timeline: patch.timeline ?? []
  };
}

describe("ExcelExportService", () => {
  it("会导出岗位候选人全集，并包含简历、评估和风险跟进信息", async () => {
    const job: JobRequirement = {
      id: "job-java",
      title: "Java后端",
      targetHeadcount: 3,
      owner: "王工",
      requirements: ["3年以上经验", "熟悉Spring Boot"],
      supplements: ["有高并发经验优先"],
      status: "open",
      createdAt: now,
      updatedAt: now
    };
    const keyCandidate = buildCandidate({
      id: "candidate-zhangsan",
      name: "张三",
      phone: "13800138000",
      jobId: job.id,
      owner: "王工",
      matchScore: 91,
      risks: ["薪资期望偏高"],
      resumeProfile: {
        email: "zhangsan@example.com",
        location: "上海",
        birthDate: "1996-01-01",
        workYears: "5年",
        education: [{ school: "浙江大学", degree: "本科", major: "计算机科学", period: "2014-2018" }],
        internships: [],
        workExperiences: [{ company: "某互联网公司", role: "后端工程师", period: "2020-2026", description: "负责交易系统", highlights: ["高并发"] }],
        projects: [{ name: "订单系统", role: "负责人", period: "2024", description: "重构核心链路", techStack: ["Java", "MySQL"], highlights: ["性能提升"] }],
        skills: ["Java", "Spring Boot", "MySQL"],
        certificates: ["PMP"],
        languages: ["英语"],
        rawHighlights: ["交易系统经验"]
      },
      evaluation: {
        matchScore: 91,
        recommendation: "strong_match",
        abilityAssessment: {
          technical: 90,
          project: 88,
          domain: 80,
          communication: 82,
          stability: 76
        },
        strengths: ["后端经验扎实"],
        weaknesses: ["薪资预期需确认"],
        risks: ["薪资期望偏高"],
        interviewFocus: ["高并发设计"],
        summary: "强匹配Java后端岗位"
      }
    });
    const normalCandidate = buildCandidate({
      id: "candidate-lisi",
      name: "李四",
      jobId: job.id,
      stage: "new",
      owner: "李工",
      matchScore: 68,
      summary: "普通新线索，不在重点和风险列表中",
      nextAction: "补充简历"
    });
    const progress: JobProgress = {
      job,
      title: job.title,
      targetHeadcount: job.targetHeadcount,
      totalCandidates: 2,
      effectiveCandidates: 2,
      offerCandidates: 0,
      gap: 1,
      stageCounts: {
        new: 1,
        screening: 1,
        interview_scheduled: 0,
        interviewing: 0,
        offer: 0,
        rejected: 0,
        withdrawn: 0,
        manual_review: 0
      },
      candidates: [keyCandidate, normalCandidate],
      keyCandidates: [{ candidate: keyCandidate, priorityScore: 95, reasons: ["匹配度高"] }],
      riskCandidates: [{ candidate: keyCandidate, riskLevel: "medium", reasons: ["薪资期望偏高"] }],
      summary: "Java后端：目标3人，有效候选2人，Offer 0人，风险候选1人，缺口1人。"
    };

    const buffer = await new ExcelExportService().exportJobProgress(job, progress);
    const workbook = new ExcelJS.Workbook();
    const excelBuffer = buffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(excelBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "岗位概览",
      "阶段漏斗",
      "候选人明细",
      "简历画像",
      "评估与面试建议",
      "重点候选人",
      "风险与跟进",
      "数据字典"
    ]);

    const detail = workbook.getWorksheet("候选人明细");
    expect(detail).toBeDefined();
    expect(detail?.getColumn(1).values).toEqual(expect.arrayContaining(["张三", "李四"]));
    expect(detail?.getColumn(13).values).toContain("补充简历");

    const resume = workbook.getWorksheet("简历画像");
    expect(resume?.getColumn(6).values.join("|")).toContain("浙江大学");
    expect(resume?.getColumn(12).values.join("|")).toContain("订单系统");

    const evaluation = workbook.getWorksheet("评估与面试建议");
    expect(evaluation?.getColumn(11).values.join("|")).toContain("高并发设计");

    const risk = workbook.getWorksheet("风险与跟进");
    expect(risk?.getColumn(6).values.join("|")).toContain("薪资期望偏高");
  });
});

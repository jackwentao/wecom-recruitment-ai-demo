import ExcelJS from "exceljs";
import type { JobProgress, JobRequirement } from "../../shared/types";
import { stageLabels } from "../../shared/types";

export class ExcelExportService {
  async exportJobProgress(job: JobRequirement, progress: JobProgress): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "招聘AI助手";
    workbook.created = new Date();

    const overview = workbook.addWorksheet("岗位概览");
    overview.columns = [
      { header: "指标", key: "metric", width: 24 },
      { header: "数值", key: "value", width: 40 }
    ];
    overview.addRows([
      { metric: "岗位", value: job.title },
      { metric: "目标人数", value: job.targetHeadcount ?? "未录入" },
      { metric: "负责人", value: job.owner ?? "待确认" },
      { metric: "有效候选人数", value: progress.effectiveCandidates },
      { metric: "Offer人数", value: progress.offerCandidates },
      { metric: "风险候选人数", value: progress.riskCandidates.length },
      { metric: "总结", value: progress.summary }
    ]);

    const funnel = workbook.addWorksheet("阶段漏斗");
    funnel.columns = [
      { header: "阶段", key: "stage", width: 22 },
      { header: "人数", key: "count", width: 12 }
    ];
    Object.entries(progress.stageCounts).forEach(([stage, count]) => {
      funnel.addRow({ stage: stageLabels[stage as keyof typeof stageLabels], count });
    });

    const key = workbook.addWorksheet("重点候选人");
    key.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "岗位", key: "position", width: 20 },
      { header: "阶段", key: "stage", width: 16 },
      { header: "负责人", key: "owner", width: 14 },
      { header: "优先级分", key: "score", width: 12 },
      { header: "匹配度", key: "matchScore", width: 12 },
      { header: "推荐结论", key: "recommendation", width: 14 },
      { header: "下一步", key: "nextAction", width: 40 }
    ];
    progress.keyCandidates.forEach(({ candidate, priorityScore }) => {
      key.addRow({
        name: candidate.name,
        position: candidate.position,
        stage: stageLabels[candidate.stage],
        owner: candidate.owner ?? "待确认",
        score: priorityScore,
        matchScore: candidate.matchScore ?? "",
        recommendation: candidate.evaluation?.recommendation ?? "",
        nextAction: candidate.nextAction
      });
    });

    const risk = workbook.addWorksheet("风险候选人");
    risk.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "岗位", key: "position", width: 20 },
      { header: "风险等级", key: "level", width: 12 },
      { header: "原因", key: "reasons", width: 50 }
    ];
    progress.riskCandidates.forEach(({ candidate, riskLevel, reasons }) => {
      risk.addRow({
        name: candidate.name,
        position: candidate.position,
        level: riskLevel,
        reasons: reasons.join("，")
      });
    });

    const all = workbook.addWorksheet("全部候选人");
    all.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "岗位", key: "position", width: 20 },
      { header: "阶段", key: "stage", width: 16 },
      { header: "负责人", key: "owner", width: 14 },
      { header: "面试时间", key: "interviewTime", width: 24 },
      { header: "匹配度", key: "matchScore", width: 12 },
      { header: "学校/专业", key: "education", width: 36 },
      { header: "技能", key: "skills", width: 36 },
      { header: "项目", key: "projects", width: 50 },
      { header: "评估摘要", key: "evaluationSummary", width: 50 },
      { header: "摘要", key: "summary", width: 50 }
    ];
    const candidates = [
      ...progress.keyCandidates.map((item) => item.candidate),
      ...progress.riskCandidates.map((item) => item.candidate)
    ];
    const unique = Array.from(new Map(candidates.map((candidate) => [candidate.id, candidate])).values());
    unique.forEach((candidate) => {
      all.addRow({
        name: candidate.name,
        position: candidate.position,
        stage: stageLabels[candidate.stage],
        owner: candidate.owner ?? "待确认",
        interviewTime: candidate.interviewTime ?? "",
        matchScore: candidate.matchScore ?? "",
        education:
          candidate.resumeProfile?.education
            .map((item) => [item.school, item.major].filter(Boolean).join("/"))
            .filter(Boolean)
            .join("，") ?? "",
        skills: candidate.resumeProfile?.skills.join("，") ?? "",
        projects: candidate.resumeProfile?.projects.map((item) => item.name).filter(Boolean).join("，") ?? "",
        evaluationSummary: candidate.evaluation?.summary ?? "",
        summary: candidate.summary
      });
    });

    for (const worksheet of workbook.worksheets) {
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEAF3FF" }
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}

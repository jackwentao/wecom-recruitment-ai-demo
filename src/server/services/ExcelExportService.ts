import ExcelJS from "exceljs";
import type {
  Candidate,
  CandidateRisk,
  JobProgress,
  JobRequirement,
  ResumeEducation,
  ResumeExperience,
  ResumeProject,
  RecommendationLevel,
  RecruitmentStage
} from "../../shared/types";
import { stageLabels } from "../../shared/types";

const recommendationLabels: Record<RecommendationLevel, string> = {
  strong_match: "强匹配",
  match: "匹配",
  weak_match: "弱匹配",
  not_match: "不匹配"
};

const riskLevelLabels: Record<CandidateRisk["riskLevel"], string> = {
  high: "高",
  medium: "中",
  low: "低"
};

const jobStatusLabels: Record<JobRequirement["status"], string> = {
  open: "招聘中",
  paused: "暂停",
  closed: "已关闭"
};

const stagePriority: Record<RecruitmentStage, number> = {
  offer: 80,
  interviewing: 70,
  interview_scheduled: 60,
  screening: 50,
  new: 40,
  manual_review: 30,
  withdrawn: 20,
  rejected: 10
};

export class ExcelExportService {
  async exportJobProgress(job: JobRequirement, progress: JobProgress): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "招聘AI助手";
    workbook.created = new Date();

    const riskByCandidateId = new Map(progress.riskCandidates.map((item) => [item.candidate.id, item]));
    this.addOverviewSheet(workbook, job, progress);
    this.addStageFunnelSheet(workbook, progress);
    this.addCandidateDetailSheet(workbook, progress, riskByCandidateId);
    this.addResumeProfileSheet(workbook, progress);
    this.addEvaluationSheet(workbook, progress);
    this.addKeyCandidateSheet(workbook, progress);
    this.addRiskAndFollowupSheet(workbook, progress, riskByCandidateId);
    this.addDictionarySheet(workbook);

    workbook.worksheets.forEach((worksheet) => this.applyWorksheetStyle(worksheet));

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private addOverviewSheet(workbook: ExcelJS.Workbook, job: JobRequirement, progress: JobProgress): void {
    const overview = workbook.addWorksheet("岗位概览");
    overview.columns = [
      { header: "指标", key: "metric", width: 24 },
      { header: "数值", key: "value", width: 60 }
    ];
    overview.addRows([
      { metric: "岗位", value: job.title },
      { metric: "岗位状态", value: jobStatusLabels[job.status] },
      { metric: "目标人数", value: job.targetHeadcount ?? "未录入" },
      { metric: "负责人", value: job.owner ?? "待确认" },
      { metric: "总候选人数", value: progress.totalCandidates },
      { metric: "有效候选人数", value: progress.effectiveCandidates },
      { metric: "Offer人数", value: progress.offerCandidates },
      { metric: "招聘缺口", value: progress.gap ?? "未录入目标人数" },
      { metric: "风险候选人数", value: progress.riskCandidates.length },
      { metric: "岗位要求", value: this.joinValues(job.requirements) || "未录入" },
      { metric: "补充说明", value: this.joinValues(job.supplements) || "未录入" },
      { metric: "岗位更新时间", value: this.formatDateTime(job.updatedAt) },
      { metric: "总结", value: progress.summary }
    ]);
  }

  private addStageFunnelSheet(workbook: ExcelJS.Workbook, progress: JobProgress): void {
    const funnel = workbook.addWorksheet("阶段漏斗");
    funnel.columns = [
      { header: "阶段", key: "stage", width: 22 },
      { header: "人数", key: "count", width: 12 },
      { header: "占比", key: "ratio", width: 12 }
    ];
    Object.entries(progress.stageCounts).forEach(([stage, count]) => {
      funnel.addRow({
        stage: stageLabels[stage as RecruitmentStage],
        count,
        ratio: progress.totalCandidates ? count / progress.totalCandidates : 0
      });
    });
    funnel.getColumn("ratio").numFmt = "0.00%";
  }

  private addCandidateDetailSheet(
    workbook: ExcelJS.Workbook,
    progress: JobProgress,
    riskByCandidateId: Map<string, CandidateRisk>
  ): void {
    const detail = workbook.addWorksheet("候选人明细");
    detail.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "手机号", key: "phone", width: 18 },
      { header: "岗位", key: "position", width: 22 },
      { header: "阶段", key: "stage", width: 16 },
      { header: "负责人", key: "owner", width: 14 },
      { header: "来源群", key: "sourceGroup", width: 22 },
      { header: "面试时间", key: "interviewTime", width: 22 },
      { header: "匹配度", key: "matchScore", width: 12 },
      { header: "推荐结论", key: "recommendation", width: 14 },
      { header: "AI置信度", key: "confidence", width: 12 },
      { header: "风险等级", key: "riskLevel", width: 12 },
      { header: "风险数量", key: "riskCount", width: 12 },
      { header: "下一步动作", key: "nextAction", width: 36 },
      { header: "候选人摘要", key: "summary", width: 50 },
      { header: "创建时间", key: "createdAt", width: 22 },
      { header: "更新时间", key: "updatedAt", width: 22 }
    ];
    this.sortedCandidates(progress.candidates).forEach((candidate) => {
      const risk = riskByCandidateId.get(candidate.id);
      detail.addRow({
        name: candidate.name,
        phone: candidate.phone ?? "",
        position: candidate.position,
        stage: stageLabels[candidate.stage],
        owner: candidate.owner ?? "待确认",
        sourceGroup: candidate.sourceGroup ?? "",
        interviewTime: candidate.interviewTime ?? "",
        matchScore: candidate.matchScore ?? candidate.evaluation?.matchScore ?? "",
        recommendation: candidate.evaluation ? recommendationLabels[candidate.evaluation.recommendation] : "",
        confidence: candidate.confidence,
        riskLevel: risk ? riskLevelLabels[risk.riskLevel] : candidate.risks.length ? "待评估" : "",
        riskCount: this.riskReasons(candidate, risk).length,
        nextAction: candidate.nextAction,
        summary: candidate.summary,
        createdAt: this.formatDateTime(candidate.createdAt),
        updatedAt: this.formatDateTime(candidate.updatedAt)
      });
    });
  }

  private addResumeProfileSheet(workbook: ExcelJS.Workbook, progress: JobProgress): void {
    const resume = workbook.addWorksheet("简历画像");
    resume.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "邮箱", key: "email", width: 26 },
      { header: "所在地", key: "location", width: 16 },
      { header: "出生日期", key: "birthDate", width: 16 },
      { header: "工作年限", key: "workYears", width: 14 },
      { header: "最高学历/学校/专业", key: "education", width: 42 },
      { header: "技能", key: "skills", width: 42 },
      { header: "证书", key: "certificates", width: 32 },
      { header: "语言", key: "languages", width: 24 },
      { header: "工作经历", key: "workExperiences", width: 52 },
      { header: "实习经历", key: "internships", width: 42 },
      { header: "项目经历", key: "projects", width: 52 },
      { header: "简历亮点", key: "rawHighlights", width: 52 }
    ];
    this.sortedCandidates(progress.candidates).forEach((candidate) => {
      const profile = candidate.resumeProfile;
      resume.addRow({
        name: candidate.name,
        email: profile?.email ?? "",
        location: profile?.location ?? "",
        birthDate: profile?.birthDate ?? "",
        workYears: profile?.workYears ?? "",
        education: profile ? this.formatEducation(profile.education) : "",
        skills: this.joinValues(profile?.skills),
        certificates: this.joinValues(profile?.certificates),
        languages: this.joinValues(profile?.languages),
        workExperiences: profile ? this.formatExperiences(profile.workExperiences) : "",
        internships: profile ? this.formatExperiences(profile.internships) : "",
        projects: profile ? this.formatProjects(profile.projects) : "",
        rawHighlights: this.joinValues(profile?.rawHighlights)
      });
    });
  }

  private addEvaluationSheet(workbook: ExcelJS.Workbook, progress: JobProgress): void {
    const evaluation = workbook.addWorksheet("评估与面试建议");
    evaluation.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "综合匹配分", key: "matchScore", width: 14 },
      { header: "推荐结论", key: "recommendation", width: 14 },
      { header: "技术能力", key: "technical", width: 12 },
      { header: "项目能力", key: "project", width: 12 },
      { header: "业务领域", key: "domain", width: 12 },
      { header: "沟通", key: "communication", width: 12 },
      { header: "稳定性", key: "stability", width: 12 },
      { header: "优势", key: "strengths", width: 42 },
      { header: "短板", key: "weaknesses", width: 42 },
      { header: "面试关注点", key: "interviewFocus", width: 48 },
      { header: "评估摘要", key: "summary", width: 52 }
    ];
    this.sortedCandidates(progress.candidates).forEach((candidate) => {
      const item = candidate.evaluation;
      evaluation.addRow({
        name: candidate.name,
        matchScore: item?.matchScore ?? candidate.matchScore ?? "",
        recommendation: item ? recommendationLabels[item.recommendation] : "",
        technical: item?.abilityAssessment.technical ?? "",
        project: item?.abilityAssessment.project ?? "",
        domain: item?.abilityAssessment.domain ?? "",
        communication: item?.abilityAssessment.communication ?? "",
        stability: item?.abilityAssessment.stability ?? "",
        strengths: this.joinValues(item?.strengths),
        weaknesses: this.joinValues(item?.weaknesses),
        interviewFocus: this.joinValues(item?.interviewFocus),
        summary: item?.summary ?? ""
      });
    });
  }

  private addKeyCandidateSheet(workbook: ExcelJS.Workbook, progress: JobProgress): void {
    const key = workbook.addWorksheet("重点候选人");
    key.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "岗位", key: "position", width: 20 },
      { header: "阶段", key: "stage", width: 16 },
      { header: "负责人", key: "owner", width: 14 },
      { header: "优先级分", key: "score", width: 12 },
      { header: "推荐原因", key: "reasons", width: 40 },
      { header: "匹配度", key: "matchScore", width: 12 },
      { header: "推荐结论", key: "recommendation", width: 14 },
      { header: "下一步", key: "nextAction", width: 40 }
    ];
    progress.keyCandidates.forEach(({ candidate, priorityScore, reasons }) => {
      key.addRow({
        name: candidate.name,
        position: candidate.position,
        stage: stageLabels[candidate.stage],
        owner: candidate.owner ?? "待确认",
        score: priorityScore,
        reasons: this.joinValues(reasons),
        matchScore: candidate.matchScore ?? candidate.evaluation?.matchScore ?? "",
        recommendation: candidate.evaluation ? recommendationLabels[candidate.evaluation.recommendation] : "",
        nextAction: candidate.nextAction
      });
    });
  }

  private addRiskAndFollowupSheet(
    workbook: ExcelJS.Workbook,
    progress: JobProgress,
    riskByCandidateId: Map<string, CandidateRisk>
  ): void {
    const risk = workbook.addWorksheet("风险与跟进");
    risk.columns = [
      { header: "姓名", key: "name", width: 14 },
      { header: "岗位", key: "position", width: 20 },
      { header: "阶段", key: "stage", width: 16 },
      { header: "负责人", key: "owner", width: 14 },
      { header: "风险等级", key: "level", width: 12 },
      { header: "风险/阻塞原因", key: "reasons", width: 50 },
      { header: "下一步动作", key: "nextAction", width: 42 },
      { header: "更新时间", key: "updatedAt", width: 22 }
    ];
    const candidates = this.sortedRiskCandidates(progress.candidates, riskByCandidateId);
    candidates.forEach((candidate) => {
      const item = riskByCandidateId.get(candidate.id);
      const reasons = this.riskReasons(candidate, item);
      risk.addRow({
        name: candidate.name,
        position: candidate.position,
        stage: stageLabels[candidate.stage],
        owner: candidate.owner ?? "待确认",
        level: item ? riskLevelLabels[item.riskLevel] : reasons.length ? "待评估" : "",
        reasons: this.joinValues(reasons),
        nextAction: candidate.nextAction,
        updatedAt: this.formatDateTime(candidate.updatedAt)
      });
    });
  }

  private addDictionarySheet(workbook: ExcelJS.Workbook): void {
    const dictionary = workbook.addWorksheet("数据字典");
    dictionary.columns = [
      { header: "类型", key: "type", width: 18 },
      { header: "编码", key: "code", width: 24 },
      { header: "说明", key: "label", width: 32 }
    ];
    Object.entries(stageLabels).forEach(([code, label]) => {
      dictionary.addRow({ type: "候选人阶段", code, label });
    });
    Object.entries(recommendationLabels).forEach(([code, label]) => {
      dictionary.addRow({ type: "推荐结论", code, label });
    });
    Object.entries(riskLevelLabels).forEach(([code, label]) => {
      dictionary.addRow({ type: "风险等级", code, label });
    });
  }

  private applyWorksheetStyle(worksheet: ExcelJS.Worksheet): void {
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEAF3FF" }
    };
    worksheet.getRow(1).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    if (worksheet.columnCount > 0) {
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: worksheet.columnCount }
      };
    }
    worksheet.columns.forEach((column) => {
      column.alignment = { vertical: "top", wrapText: true };
    });
  }

  private sortedCandidates(candidates: Candidate[]): Candidate[] {
    return [...candidates].sort((left, right) => {
      const stageDiff = stagePriority[right.stage] - stagePriority[left.stage];
      if (stageDiff) return stageDiff;
      const scoreDiff = this.candidateScore(right) - this.candidateScore(left);
      if (scoreDiff) return scoreDiff;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }

  private sortedRiskCandidates(candidates: Candidate[], riskByCandidateId: Map<string, CandidateRisk>): Candidate[] {
    return this.sortedCandidates(candidates).sort((left, right) => {
      const leftRisk = riskByCandidateId.get(left.id);
      const rightRisk = riskByCandidateId.get(right.id);
      const riskDiff = this.riskWeight(rightRisk?.riskLevel) - this.riskWeight(leftRisk?.riskLevel);
      if (riskDiff) return riskDiff;
      return this.riskReasons(right, rightRisk).length - this.riskReasons(left, leftRisk).length;
    });
  }

  private riskReasons(candidate: Candidate, risk?: CandidateRisk): string[] {
    const reasons = new Set<string>(risk?.reasons ?? []);
    candidate.risks.forEach((item) => reasons.add(item));
    if (!candidate.owner) reasons.add("缺少负责人");
    if (!candidate.nextAction) reasons.add("缺少下一步动作");
    return Array.from(reasons).filter(Boolean);
  }

  private candidateScore(candidate: Candidate): number {
    return candidate.matchScore ?? candidate.evaluation?.matchScore ?? Math.round(candidate.confidence * 100);
  }

  private riskWeight(level: CandidateRisk["riskLevel"] | undefined): number {
    if (level === "high") return 30;
    if (level === "medium") return 20;
    if (level === "low") return 10;
    return 0;
  }

  private formatEducation(items: ResumeEducation[]): string {
    return this.joinValues(
      items.map((item) => [item.educationLevel ?? item.degree, item.school, item.major, item.period].filter(Boolean).join("/"))
    );
  }

  private formatExperiences(items: ResumeExperience[]): string {
    return this.joinValues(
      items.map((item) =>
        [item.company, item.role, item.period, item.description, this.joinValues(item.highlights)].filter(Boolean).join(" / ")
      )
    );
  }

  private formatProjects(items: ResumeProject[]): string {
    return this.joinValues(
      items.map((item) =>
        [
          item.name,
          item.role,
          item.period,
          item.description,
          item.techStack.length ? `技术栈：${this.joinValues(item.techStack)}` : "",
          this.joinValues(item.highlights)
        ]
          .filter(Boolean)
          .join(" / ")
      )
    );
  }

  private formatDateTime(value: string | undefined): string {
    if (!value) return "";
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return value;
    return time.toLocaleString("zh-CN", { hour12: false });
  }

  private joinValues(values: string[] | undefined): string {
    return values?.filter(Boolean).join("；") ?? "";
  }
}

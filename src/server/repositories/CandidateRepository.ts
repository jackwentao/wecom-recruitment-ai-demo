import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AppDataStore } from "./AppDataStore";
import type {
  AppData,
  Candidate,
  CandidateRisk,
  CandidateScore,
  DashboardMetrics,
  ExtractedRecruitmentInfo,
  FollowUpTask,
  JobProgress,
  JobRequirement,
  PendingTask,
  RawRecruitmentMessage,
  RecruitmentStage
} from "../../shared/types";
import { effectiveStages } from "../../shared/types";

type InterviewRound = "一面" | "二面" | "三面" | "四面" | "终面" | "复试";

const emptyData = (): AppData => ({
  messages: [],
  candidates: [],
  tasks: [],
  jobs: [],
  pendingTasks: []
});

export class CandidateRepository {
  constructor(private readonly storage: string | AppDataStore) {}

  async all(): Promise<AppData> {
    if (typeof this.storage !== "string") {
      return this.storage.load();
    }
    try {
      const content = await fs.readFile(this.storage, "utf-8");
      const parsed = JSON.parse(content) as Partial<AppData>;
      return {
        messages: parsed.messages ?? [],
        candidates: parsed.candidates ?? [],
        tasks: parsed.tasks ?? [],
        jobs: parsed.jobs ?? [],
        pendingTasks: parsed.pendingTasks ?? []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyData();
      }
      throw error;
    }
  }

  async save(data: AppData): Promise<void> {
    if (typeof this.storage !== "string") {
      await this.storage.save(data);
      return;
    }
    await fs.mkdir(path.dirname(this.storage), { recursive: true });
    await fs.writeFile(this.storage, JSON.stringify(data, null, 2), "utf-8");
  }

  async clear(): Promise<AppData> {
    const data = emptyData();
    await this.save(data);
    return data;
  }

  async addMessage(message: RawRecruitmentMessage): Promise<void> {
    const data = await this.all();
    data.messages.unshift(message);
    await this.save(data);
  }

  async updateMessage(message: RawRecruitmentMessage): Promise<void> {
    const data = await this.all();
    data.messages = data.messages.map((item) => (item.id === message.id ? message : item));
    await this.save(data);
  }

  async upsertCandidate(
    message: RawRecruitmentMessage,
    extraction: ExtractedRecruitmentInfo
  ): Promise<{ candidate: Candidate; task: FollowUpTask; created: boolean }> {
    const data = await this.all();
    const now = new Date().toISOString();
    const normalizedName = extraction.candidateName.trim();
    const candidateKey = (candidate: Candidate) =>
      candidate.name === normalizedName &&
      (extraction.jobId ? candidate.jobId === extraction.jobId : candidate.position === extraction.position) &&
      (!extraction.phone || candidate.phone === extraction.phone);
    const sameNameCandidates = data.candidates.filter((candidate) =>
      this.isSameCandidateName(candidate.name, normalizedName)
    );
    const existing = data.candidates.find(candidateKey) ?? this.selectExistingCandidateForUpsert(sameNameCandidates, extraction);
    const timelineItem = {
      id: nanoid(),
      messageId: message.id,
      content: message.content,
      createdAt: now,
      summary: extraction.summary
    };

    let candidate: Candidate;
    let created = false;
    if (existing) {
      const interviewTime = this.resolveInterviewTime(existing, extraction, message.content);
      candidate = {
        ...existing,
        name: this.normalizeCandidateName(existing.name) || existing.name,
        phone: extraction.phone ?? existing.phone,
        jobId: extraction.jobId ?? existing.jobId,
        stage: extraction.stage,
        owner: extraction.owner ?? existing.owner,
        sourceGroup: extraction.sourceGroup ?? message.groupName ?? existing.sourceGroup,
        interviewTime,
        summary: extraction.summary,
        risks: extraction.risks,
        nextAction: extraction.nextAction,
        confidence: extraction.confidence,
        resumeProfile: this.mergeResumeProfile(existing.resumeProfile, extraction.resumeProfile),
        matchScore: extraction.matchScore ?? existing.matchScore,
        evaluation: extraction.evaluation ?? existing.evaluation,
        updatedAt: now,
        timeline: [timelineItem, ...existing.timeline]
      };
      data.candidates = data.candidates.map((item) => (item.id === existing.id ? candidate : item));
    } else {
      created = true;
      candidate = {
        id: nanoid(),
        name: normalizedName,
        phone: extraction.phone,
        jobId: extraction.jobId,
        position: extraction.position,
        stage: extraction.stage,
        owner: extraction.owner,
        sourceGroup: extraction.sourceGroup ?? message.groupName,
        interviewTime: extraction.interviewTime,
        summary: extraction.summary,
        risks: extraction.risks,
        nextAction: extraction.nextAction,
        confidence: extraction.confidence,
        resumeProfile: extraction.resumeProfile,
        matchScore: extraction.matchScore,
        evaluation: extraction.evaluation,
        createdAt: now,
        updatedAt: now,
        timeline: [timelineItem]
      };
      data.candidates.unshift(candidate);
    }

    const task: FollowUpTask = {
      id: nanoid(),
      candidateId: candidate.id,
      title: extraction.nextAction || `跟进候选人${candidate.name}`,
      owner: extraction.owner,
      dueAt: extraction.interviewTime,
      status: "open",
      createdAt: now
    };
    data.tasks.unshift(task);
    this.normalizeCandidateRecords(data);
    this.mergeAmbiguousDuplicateCandidates(data, candidate.id);
    data.messages = data.messages.map((item) =>
      item.id === message.id
        ? { ...message, status: "parsed", parsedCandidateId: candidate.id, extraction }
        : item
    );
    await this.save(data);
    return { candidate, task, created };
  }

  async findCandidatesByName(name: string): Promise<Candidate[]> {
    const data = await this.all();
    const normalized = name.trim();
    return data.candidates.filter((candidate) => this.isSameCandidateName(candidate.name, normalized));
  }

  async upsertJobRequirement(input: {
    title: string;
    targetHeadcount?: number;
    owner?: string;
    requirements?: string[];
    supplement?: string;
    status?: JobRequirement["status"];
  }): Promise<JobRequirement> {
    const data = await this.all();
    const now = new Date().toISOString();
    const title = input.title.trim();
    const existing = data.jobs.find((job) => this.isSameJob(job.title, title));
    let job: JobRequirement;
    if (existing) {
      job = {
        ...existing,
        targetHeadcount: input.targetHeadcount ?? existing.targetHeadcount,
        owner: input.owner ?? existing.owner,
        requirements: Array.from(new Set([...(existing.requirements ?? []), ...(input.requirements ?? [])])),
        supplements: input.supplement ? [input.supplement, ...existing.supplements] : existing.supplements,
        status: input.status ?? existing.status,
        updatedAt: now
      };
      data.jobs = data.jobs.map((item) => (item.id === existing.id ? job : item));
    } else {
      job = {
        id: nanoid(),
        title,
        targetHeadcount: input.targetHeadcount,
        owner: input.owner,
        requirements: input.requirements ?? [],
        supplements: input.supplement ? [input.supplement] : [],
        status: input.status ?? "open",
        createdAt: now,
        updatedAt: now
      };
      data.jobs.unshift(job);
    }
    await this.save(data);
    return job;
  }

  async updateJob(id: string, patch: Partial<Omit<JobRequirement, "id" | "createdAt">>): Promise<JobRequirement | undefined> {
    const data = await this.all();
    const now = new Date().toISOString();
    let updated: JobRequirement | undefined;
    data.jobs = data.jobs.map((job) => {
      if (job.id !== id) return job;
      updated = { ...job, ...patch, updatedAt: now };
      return updated;
    });
    await this.save(data);
    return updated;
  }

  async listJobs(): Promise<JobRequirement[]> {
    const data = await this.all();
    return data.jobs;
  }

  async getJob(id: string): Promise<JobRequirement | undefined> {
    const data = await this.all();
    return data.jobs.find((job) => job.id === id);
  }

  async findJobsByTitle(title: string): Promise<JobRequirement[]> {
    const data = await this.all();
    const normalized = this.normalizeJobTitle(title);
    return data.jobs.filter((job) => {
      const jobTitle = this.normalizeJobTitle(job.title);
      return jobTitle === normalized;
    });
  }

  async findSimilarJobs(title: string, limit = 5): Promise<JobRequirement[]> {
    const data = await this.all();
    const normalized = this.normalizeJobTitle(title);
    const chars = new Set(normalized.split("").filter(Boolean));
    return data.jobs
      .map((job) => {
        const jobTitle = this.normalizeJobTitle(job.title);
        const overlap = jobTitle.split("").filter((char) => chars.has(char)).length;
        const score = this.isSameJob(job.title, title) ? 100 : overlap;
        return { job, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.job);
  }

  async createPendingTask(input: {
    type: PendingTask["type"];
    groupId?: string;
    requesterId?: string;
    originalMessageId?: string;
    prompt: string;
    options?: string[];
    context: Record<string, unknown>;
    ttlMinutes?: number;
  }): Promise<PendingTask> {
    const data = await this.all();
    const now = new Date();
    const pendingTask: PendingTask = {
      id: this.nextTaskId(now),
      type: input.type,
      groupId: input.groupId,
      requesterId: input.requesterId,
      originalMessageId: input.originalMessageId,
      status: "waiting",
      prompt: input.prompt,
      options: input.options,
      context: input.context,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMinutes ?? 30) * 60 * 1000).toISOString()
    };
    data.pendingTasks.unshift(pendingTask);
    await this.save(data);
    return pendingTask;
  }

  async listPendingTasks(): Promise<PendingTask[]> {
    const data = await this.all();
    const now = Date.now();
    return data.pendingTasks.map((task) =>
      task.status === "waiting" && new Date(task.expiresAt).getTime() < now ? { ...task, status: "expired" } : task
    );
  }

  async resolvePendingTask(id: string): Promise<PendingTask | undefined> {
    const data = await this.all();
    const now = new Date().toISOString();
    let resolved: PendingTask | undefined;
    data.pendingTasks = data.pendingTasks.map((task) => {
      if (task.id !== id) return task;
      resolved = { ...task, status: "resolved", resolvedAt: now };
      return resolved;
    });
    await this.save(data);
    return resolved;
  }

  async getPendingTask(id: string): Promise<PendingTask | undefined> {
    const data = await this.all();
    const task = data.pendingTasks.find((item) => item.id === id);
    if (!task) return undefined;
    if (task.status === "waiting" && new Date(task.expiresAt).getTime() < Date.now()) {
      return { ...task, status: "expired" };
    }
    return task;
  }

  async jobProgress(titleOrId: string): Promise<JobProgress> {
    const data = await this.all();
    const job =
      data.jobs.find((item) => item.id === titleOrId) ??
      data.jobs.find((item) => this.isSameJob(item.title, titleOrId));
    const title = job?.title ?? titleOrId;
    const candidates = data.candidates.filter((candidate) =>
      job?.id ? candidate.jobId === job.id || this.isSameJob(candidate.position, title) : this.isSameJob(candidate.position, title)
    );
    const stageCounts = this.emptyStageCounts();
    for (const candidate of candidates) {
      stageCounts[candidate.stage] += 1;
    }
    const effective = candidates.filter((candidate) => effectiveStages.includes(candidate.stage));
    const keyCandidates = effective
      .map((candidate) => this.scoreCandidate(candidate))
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, 5);
    const riskCandidates = effective
      .map((candidate) => this.riskCandidate(candidate))
      .filter((risk): risk is CandidateRisk => Boolean(risk))
      .sort((a, b) => this.riskWeight(b.riskLevel) - this.riskWeight(a.riskLevel))
      .slice(0, 5);
    const gap = job?.targetHeadcount === undefined ? undefined : Math.max(job.targetHeadcount - effective.length, 0);
    const summary = this.buildProgressSummary(title, job?.targetHeadcount, effective.length, stageCounts.offer, riskCandidates.length);
    return {
      job,
      title,
      targetHeadcount: job?.targetHeadcount,
      totalCandidates: candidates.length,
      effectiveCandidates: effective.length,
      offerCandidates: stageCounts.offer,
      gap,
      stageCounts,
      candidates,
      keyCandidates,
      riskCandidates,
      summary
    };
  }

  async markMessageNeedsReview(message: RawRecruitmentMessage, error: string): Promise<void> {
    const data = await this.all();
    data.messages = data.messages.map((item) =>
      item.id === message.id ? { ...message, status: "needs_review", error } : item
    );
    await this.save(data);
  }

  async attachReply(messageId: string, replyText: string): Promise<void> {
    const data = await this.all();
    data.messages = data.messages.map((item) => (item.id === messageId ? { ...item, replyText } : item));
    await this.save(data);
  }

  async listCandidates(filters: {
    stage?: RecruitmentStage;
    position?: string;
    owner?: string;
  }): Promise<Candidate[]> {
    const data = await this.all();
    const namesChanged = this.normalizeCandidateRecords(data);
    const changed = this.mergeAmbiguousDuplicateCandidates(data);
    if (namesChanged || changed) await this.save(data);
    return data.candidates.filter((candidate) => {
      if (filters.stage && candidate.stage !== filters.stage) return false;
      if (filters.position && !candidate.position.includes(filters.position)) return false;
      if (filters.owner && candidate.owner !== filters.owner) return false;
      return true;
    });
  }

  async getCandidate(id: string): Promise<Candidate | undefined> {
    const data = await this.all();
    return data.candidates.find((candidate) => candidate.id === id);
  }

  async updateStage(id: string, stage: RecruitmentStage): Promise<Candidate | undefined> {
    const data = await this.all();
    const now = new Date().toISOString();
    let updated: Candidate | undefined;
    data.candidates = data.candidates.map((candidate) => {
      if (candidate.id !== id) return candidate;
      updated = { ...candidate, stage, updatedAt: now };
      return updated;
    });
    await this.save(data);
    return updated;
  }

  async metrics(): Promise<DashboardMetrics> {
    const data = await this.all();
    const stageCounts = data.candidates.reduce(
      (acc, candidate) => {
        acc[candidate.stage] += 1;
        return acc;
      },
      this.emptyStageCounts()
    );
    const parsedCount = data.messages.filter((message) => message.status === "parsed").length;
    const now = Date.now();
    return {
      totalCandidates: data.candidates.length,
      openTasks: data.tasks.filter((task) => task.status === "open").length,
      overdueTasks: data.tasks.filter(
        (task) => task.status === "open" && task.dueAt && new Date(task.dueAt).getTime() < now
      ).length,
      parseSuccessRate: data.messages.length === 0 ? 0 : Math.round((parsedCount / data.messages.length) * 100),
      stageCounts
    };
  }

  private emptyStageCounts(): Record<RecruitmentStage, number> {
    return {
      new: 0,
      screening: 0,
      interview_scheduled: 0,
      interviewing: 0,
      offer: 0,
      rejected: 0,
      withdrawn: 0,
      manual_review: 0
    };
  }

  private scoreCandidate(candidate: Candidate): CandidateScore {
    const reasons: string[] = [];
    let priorityScore = 0;
    const stageScores: Record<RecruitmentStage, number> = {
      new: 10,
      screening: 20,
      interview_scheduled: 30,
      interviewing: 40,
      offer: 55,
      rejected: 0,
      withdrawn: 0,
      manual_review: 5
    };
    priorityScore += stageScores[candidate.stage];
    reasons.push(`阶段优先级${stageScores[candidate.stage]}`);
    const matchScore = candidate.matchScore ?? Math.round(candidate.confidence * 100);
    if (matchScore >= 85) {
      priorityScore += 30;
      reasons.push("匹配度高");
    } else if (matchScore >= 70) {
      priorityScore += 20;
      reasons.push("匹配度较好");
    } else if (matchScore >= 60) {
      priorityScore += 10;
      reasons.push("匹配度可推进");
    }
    if (!candidate.risks.length) priorityScore += 10;
    if (candidate.owner) priorityScore += 5;
    if (candidate.nextAction) priorityScore += 5;
    if (candidate.interviewTime && this.isWithinDays(candidate.interviewTime, 3)) priorityScore += 10;
    return { candidate, priorityScore, reasons };
  }

  private riskCandidate(candidate: Candidate): CandidateRisk | undefined {
    const reasons: string[] = [];
    if (candidate.risks.length) reasons.push(...candidate.risks);
    if (candidate.confidence < 0.6) reasons.push("AI置信度低");
    if (!candidate.owner) reasons.push("缺少负责人");
    if (!candidate.nextAction) reasons.push("缺少下一步动作");
    if (candidate.stage === "offer" && /薪资|犹豫|意向|比较|不确定/.test(`${candidate.summary}${candidate.risks.join("")}`)) {
      reasons.push("Offer阶段存在薪资或意向风险");
    }
    if (
      candidate.stage === "interview_scheduled" &&
      candidate.interviewTime &&
      new Date(candidate.interviewTime).getTime() < Date.now()
    ) {
      reasons.push("面试时间已过但仍无反馈");
    }
    if (!reasons.length) return undefined;
    const riskLevel: CandidateRisk["riskLevel"] =
      candidate.stage === "offer" || candidate.confidence < 0.5 || reasons.length >= 3
        ? "high"
        : reasons.length >= 2
          ? "medium"
          : "low";
    return { candidate, riskLevel, reasons };
  }

  private riskWeight(level: CandidateRisk["riskLevel"]): number {
    return level === "high" ? 3 : level === "medium" ? 2 : 1;
  }

  private buildProgressSummary(
    title: string,
    targetHeadcount: number | undefined,
    effectiveCount: number,
    offerCount: number,
    riskCount: number
  ): string {
    const targetText = targetHeadcount === undefined ? "尚未录入目标人数" : `目标${targetHeadcount}人`;
    const gapText = targetHeadcount === undefined ? "" : `，缺口${Math.max(targetHeadcount - effectiveCount, 0)}人`;
    return `${title}：${targetText}，有效候选${effectiveCount}人，Offer ${offerCount}人，风险候选${riskCount}人${gapText}。`;
  }

  private normalizeJobTitle(title: string): string {
    return title.toLowerCase().replace(/[岗位岗职位\s]/g, "");
  }

  private isSameJob(left: string, right: string): boolean {
    const normalizedLeft = this.normalizeJobTitle(left);
    const normalizedRight = this.normalizeJobTitle(right);
    return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
  }

  private isWithinDays(value: string, days: number): boolean {
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return false;
    const diff = time - Date.now();
    return diff >= 0 && diff <= days * 24 * 60 * 60 * 1000;
  }

  private mergeResumeProfile(
    existing: Candidate["resumeProfile"] | undefined,
    incoming: Candidate["resumeProfile"] | undefined
  ): Candidate["resumeProfile"] | undefined {
    if (!existing) return incoming;
    if (!incoming) return existing;
    return {
      email: incoming.email ?? existing.email,
      location: incoming.location ?? existing.location,
      birthDate: incoming.birthDate ?? existing.birthDate,
      workYears: incoming.workYears ?? existing.workYears,
      education: incoming.education.length ? incoming.education : existing.education,
      internships: incoming.internships.length ? incoming.internships : existing.internships,
      workExperiences: incoming.workExperiences.length ? incoming.workExperiences : existing.workExperiences,
      projects: incoming.projects.length ? incoming.projects : existing.projects,
      skills: incoming.skills.length ? incoming.skills : existing.skills,
      certificates: incoming.certificates.length ? incoming.certificates : existing.certificates,
      languages: incoming.languages.length ? incoming.languages : existing.languages,
      rawHighlights: incoming.rawHighlights.length ? incoming.rawHighlights : existing.rawHighlights
    };
  }

  private selectExistingCandidateForUpsert(
    candidates: Candidate[],
    extraction: ExtractedRecruitmentInfo
  ): Candidate | undefined {
    if (!candidates.length) return undefined;
    if (extraction.phone) {
      const samePhone = candidates.find((candidate) => candidate.phone === extraction.phone);
      if (samePhone) return samePhone;
    }
    if (this.isUnconfirmedPosition(extraction.position)) {
      const confirmed = candidates.filter((candidate) => candidate.jobId && !this.isUnconfirmedPosition(candidate.position));
      if (confirmed.length) return this.latestCandidate(confirmed);
    }
    const samePosition = candidates.filter(
      (candidate) =>
        !this.isUnconfirmedPosition(extraction.position) &&
        (candidate.position === extraction.position ||
          candidate.position.includes(extraction.position) ||
          extraction.position.includes(candidate.position))
    );
    if (samePosition.length) return this.latestCandidate(samePosition);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private mergeAmbiguousDuplicateCandidates(data: AppData, preferredCandidateId?: string): boolean {
    let changed = false;
    const byName = new Map<string, Candidate[]>();
    for (const candidate of data.candidates) {
      const nameKey = this.normalizeCandidateName(candidate.name);
      const items = byName.get(nameKey) ?? [];
      items.push(candidate);
      byName.set(nameKey, items);
    }

    for (const candidates of byName.values()) {
      if (candidates.length < 2) continue;
      const mergeable = candidates.filter(
        (candidate) => this.isUnconfirmedPosition(candidate.position) || !candidate.jobId || this.hasSameConfirmedJob(candidate, candidates)
      );
      if (mergeable.length < 2) continue;
      const target = this.selectDuplicateMergeTarget(mergeable, data.jobs, preferredCandidateId);
      const duplicates = mergeable.filter((candidate) => candidate.id !== target.id);
      if (!duplicates.length) continue;

      const merged = duplicates.reduce((current, duplicate) => this.mergeCandidate(current, duplicate), target);
      data.candidates = data.candidates
        .filter((candidate) => !duplicates.some((duplicate) => duplicate.id === candidate.id))
        .map((candidate) => (candidate.id === target.id ? merged : candidate));
      data.tasks = data.tasks.map((task) =>
        duplicates.some((duplicate) => duplicate.id === task.candidateId) ? { ...task, candidateId: target.id } : task
      );
      data.messages = data.messages.map((message) =>
        message.parsedCandidateId && duplicates.some((duplicate) => duplicate.id === message.parsedCandidateId)
          ? { ...message, parsedCandidateId: target.id }
          : message
      );
      changed = true;
    }
    return changed;
  }

  private selectDuplicateMergeTarget(
    candidates: Candidate[],
    jobs: JobRequirement[],
    preferredCandidateId?: string
  ): Candidate {
    const preferred = candidates.find((candidate) => candidate.id === preferredCandidateId);
    if (preferred && preferred.jobId && !this.isUnconfirmedPosition(preferred.position)) return preferred;
    const knownJobPosition = candidates.filter((candidate) => this.hasExactKnownJobPosition(candidate, jobs));
    if (knownJobPosition.length) return this.latestCandidate(knownJobPosition);
    const confirmed = candidates.filter((candidate) => candidate.jobId && !this.isUnconfirmedPosition(candidate.position));
    if (confirmed.length) return this.latestCandidate(confirmed);
    const confirmedPosition = candidates.filter((candidate) => !this.isUnconfirmedPosition(candidate.position));
    if (confirmedPosition.length) return this.latestCandidate(confirmedPosition);
    return this.latestCandidate(candidates);
  }

  private mergeCandidate(target: Candidate, duplicate: Candidate): Candidate {
    const timeline = [...target.timeline, ...duplicate.timeline].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    );
    const incomingIsNewer = Date.parse(duplicate.updatedAt) > Date.parse(target.updatedAt);
    const primary = incomingIsNewer ? duplicate : target;
    const confirmed =
      target.jobId || !this.isUnconfirmedPosition(target.position)
        ? target
        : duplicate.jobId || !this.isUnconfirmedPosition(duplicate.position)
          ? duplicate
          : target;
    const secondary = primary.id === target.id ? duplicate : target;
    return {
      ...target,
      phone: target.phone ?? duplicate.phone,
      jobId: confirmed.jobId ?? target.jobId ?? duplicate.jobId,
      position: confirmed.position && !this.isUnconfirmedPosition(confirmed.position) ? confirmed.position : target.position,
      stage: primary.stage,
      owner: primary.owner ?? target.owner ?? duplicate.owner,
      sourceGroup: target.sourceGroup ?? duplicate.sourceGroup,
      interviewTime: this.resolveMergedInterviewTime(primary, secondary, target, duplicate),
      summary: this.mergeSummary(primary.summary, primary.id === target.id ? duplicate.summary : target.summary),
      risks: Array.from(new Set([...target.risks, ...duplicate.risks])),
      nextAction: primary.nextAction || target.nextAction || duplicate.nextAction,
      confidence: Math.max(target.confidence, duplicate.confidence),
      resumeProfile: this.mergeResumeProfile(target.resumeProfile, duplicate.resumeProfile),
      matchScore: target.matchScore ?? duplicate.matchScore,
      evaluation: target.evaluation ?? duplicate.evaluation,
      updatedAt: primary.updatedAt,
      timeline
    };
  }

  private hasExactKnownJobPosition(candidate: Candidate, jobs: JobRequirement[]): boolean {
    const normalizedPosition = this.normalizeJobTitle(candidate.position);
    return Boolean(
      normalizedPosition &&
        jobs.some((job) => candidate.jobId === job.id || this.normalizeJobTitle(job.title) === normalizedPosition)
    );
  }

  private hasSameConfirmedJob(candidate: Candidate, candidates: Candidate[]): boolean {
    return Boolean(
      candidate.jobId &&
        candidates.some((item) => item.id !== candidate.id && item.jobId === candidate.jobId && item.name === candidate.name)
    );
  }

  private normalizeCandidateRecords(data: AppData): boolean {
    let changed = false;
    data.candidates = data.candidates.map((candidate) => {
      const normalizedName = this.normalizeCandidateName(candidate.name);
      if (!normalizedName || normalizedName === candidate.name) return candidate;
      changed = true;
      return { ...candidate, name: normalizedName };
    });
    return changed;
  }

  private isSameCandidateName(left: string, right: string): boolean {
    const normalizedLeft = this.normalizeCandidateName(left);
    const normalizedRight = this.normalizeCandidateName(right);
    return (
      normalizedLeft === normalizedRight ||
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)
    );
  }

  private normalizeCandidateName(name: string): string {
    return name
      .trim()
      .replace(/(?:一面|二面|三面|四面|终面|初面|复试|面试|面评|反馈|通过|不通过|淘汰|候选人|简历).*$/u, "")
      .replace(/[^\u4e00-\u9fa5A-Za-z]/g, "");
  }

  private resolveInterviewTime(
    existing: Candidate,
    extraction: ExtractedRecruitmentInfo,
    messageContent: string
  ): string | undefined {
    if (extraction.interviewTime) return extraction.interviewTime;
    if (this.hasInterviewRoundChanged(existing, extraction, messageContent)) return undefined;
    return existing.interviewTime;
  }

  private resolveMergedInterviewTime(
    primary: Candidate,
    secondary: Candidate,
    target: Candidate,
    duplicate: Candidate
  ): string | undefined {
    if (primary.interviewTime) return primary.interviewTime;
    if (this.hasCandidateRoundChanged(secondary, primary)) return undefined;
    return target.interviewTime ?? duplicate.interviewTime;
  }

  private hasInterviewRoundChanged(
    existing: Candidate,
    extraction: ExtractedRecruitmentInfo,
    messageContent: string
  ): boolean {
    const existingRound = this.extractCandidateInterviewRound(existing);
    if (!existingRound) return false;
    const incomingText = [messageContent, extraction.summary, extraction.nextAction].join("；");
    const incomingRound = this.extractTargetInterviewRound(incomingText);
    if (incomingRound) return incomingRound !== existingRound;
    return this.mentionsNextInterviewRound(incomingText);
  }

  private hasCandidateRoundChanged(previous: Candidate, current: Candidate): boolean {
    const previousRound = this.extractCandidateInterviewRound(previous);
    if (!previousRound) return false;
    const currentRound = this.extractCandidateInterviewRound(current);
    return Boolean(currentRound && currentRound !== previousRound);
  }

  private extractCandidateInterviewRound(candidate: Candidate): InterviewRound | undefined {
    return this.extractTargetInterviewRound(
      [
        candidate.nextAction,
        candidate.summary,
        ...candidate.timeline.slice(0, 3).flatMap((item) => [item.summary, item.content])
      ].join("；")
    );
  }

  private extractTargetInterviewRound(text: string): InterviewRound | undefined {
    const roundText = "(初面|一面|二面|三面|四面|终面|复试)";
    const actionBeforeRound = new RegExp(
      `(?:安排|约|预约|定|确认|更新|改到|改为|调整|推进|进入|转入|准备|邀约|约定|约了|约面|面试时间).{0,12}?${roundText}`,
      "u"
    );
    const roundBeforeAction = new RegExp(
      `${roundText}.{0,12}?(?:安排|约|预约|时间|日程|改到|改为|调整|更新|确认|跟进|负责人|面试官|反馈|结果)`,
      "u"
    );
    const actionMatch = text.match(actionBeforeRound) ?? text.match(roundBeforeAction);
    if (actionMatch?.[1]) return this.normalizeInterviewRound(actionMatch[1]);
    const allRounds = [...text.matchAll(new RegExp(roundText, "gu"))];
    const lastRound = allRounds.at(-1)?.[1];
    return lastRound ? this.normalizeInterviewRound(lastRound) : undefined;
  }

  private normalizeInterviewRound(round: string): InterviewRound {
    return round === "初面" ? "一面" : (round as InterviewRound);
  }

  private mentionsNextInterviewRound(text: string): boolean {
    return /(?:安排|约|预约|推进|进入|转入|准备|邀约).{0,8}(?:下一轮|下轮|后续面试|复试)|(?:下一轮|下轮|后续面试).{0,8}(?:安排|时间|跟进|负责人)/u.test(
      text
    );
  }

  private isUnconfirmedPosition(position: string | undefined): boolean {
    return !position || position === "待确认岗位";
  }

  private latestCandidate(candidates: Candidate[]): Candidate {
    return [...candidates].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  }

  private mergeSummary(left: string, right: string): string {
    const first = left.trim();
    const second = right.trim();
    if (!first) return second;
    if (!second || first.includes(second)) return first;
    if (second.includes(first)) return second;
    return `${first}；历史：${second}`.slice(0, 180);
  }

  private nextTaskId(now: Date): string {
    const stamp = now
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const suffix = nanoid(8)
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 4)
      .padEnd(4, "0")
      .toUpperCase();
    return `T${stamp}${suffix}`;
  }
}

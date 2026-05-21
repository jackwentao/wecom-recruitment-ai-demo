import { nanoid } from "nanoid";
import type { RecruitmentAi } from "../ai/AiExtractor";
import type { CandidateRepository } from "../repositories/CandidateRepository";
import type {
  ExtractedRecruitmentInfo,
  Candidate,
  JobRequirement,
  MessageAttachment,
  PendingTask,
  ProcessResult,
  RawRecruitmentMessage,
  RecruitmentMessageKind,
  TaskType
} from "../../shared/types";

export class RecruitmentMessageService {
  constructor(
    private readonly repository: CandidateRepository,
    private readonly ai: RecruitmentAi,
    private readonly appBaseUrl = "http://localhost:5173"
  ) {}

  async process(input: {
    source: RawRecruitmentMessage["source"];
    content: string;
    kind?: RecruitmentMessageKind;
    sender?: string;
    groupName?: string;
    messageId?: string;
    attachment?: MessageAttachment;
  }): Promise<ProcessResult> {
    const result = await this.processCore(input);
    await this.repository.attachReply(result.message.id, result.replyText);
    return { ...result, message: { ...result.message, replyText: result.replyText } };
  }

  async generateJdForJob(job: JobRequirement): Promise<string> {
    return this.ai.generateJd(job);
  }

  private async processCore(input: {
    source: RawRecruitmentMessage["source"];
    content: string;
    kind?: RecruitmentMessageKind;
    sender?: string;
    groupName?: string;
    messageId?: string;
    attachment?: MessageAttachment;
  }): Promise<ProcessResult> {
    const kind = input.kind ?? this.detectKind(input.content, input.attachment?.fileName);
    const classifiedTask = await this.ai.classifyTask({
      content: input.content,
      kind,
      fileName: input.attachment?.fileName,
      sender: input.sender,
      groupName: input.groupName
    });
    const taskType = classifiedTask.type;
    const message: RawRecruitmentMessage = {
      id: nanoid(),
      source: input.source,
      kind,
      taskType,
      content: input.content,
      sender: input.sender,
      groupName: input.groupName,
      messageId: input.messageId,
      attachment: input.attachment,
      receivedAt: new Date().toISOString(),
      status: "received"
    };
    await this.repository.addMessage(message);

    if (this.isPendingTaskReply(input.content)) {
      return this.resolvePendingReply(message, input.content);
    }

    if (message.kind === "resume_pdf" && !message.attachment?.extractedText) {
      const error = message.attachment?.extractionError ?? "PDF正文尚未抽取，等待人工确认";
      await this.repository.markMessageNeedsReview(message, error);
      return {
        message: { ...message, status: "needs_review", error },
        replyText: `已收到PDF附件${message.attachment?.fileName ? `《${message.attachment.fileName}》` : ""}，但需要人工确认：${error}`
      };
    }

    if (taskType === "job_requirement") return this.handleJobRequirement(message);
    if (taskType === "job_progress_query") return this.handleJobProgressQuery(message);
    if (taskType === "candidate_query") return this.handleCandidateQuery(message);
    if (taskType === "jd_generate") return this.handleJdGenerate(message);
    if (taskType === "unknown") return this.handleUnknown(message);

    return this.handleCandidateMutation(message);
  }

  private async handleCandidateMutation(message: RawRecruitmentMessage): Promise<ProcessResult> {
    try {
      const resumeTargetJobTitle = this.resumeTargetJobTitle(message);
      if (message.kind === "resume_pdf" && !resumeTargetJobTitle) {
        const pendingTask = await this.createJobConfirmationTask(
          message,
          "PDF简历需要绑定已存在岗位，请选择岗位ID后继续解析。",
          undefined,
          this.resumePendingContext(message)
        );
        await this.repository.updateMessage({ ...message, status: "needs_review", pendingTaskId: pendingTask.id });
        return {
          message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id },
          pendingTask,
          replyText: this.buildJobConfirmationReply(pendingTask)
        };
      }
      const aiInput = await this.buildAiInput(message);
      const extraction = await this.ai.extract(aiInput, {
        sender: message.sender,
        groupName: message.groupName
      });
      const contextualExtraction = await this.applyExistingCandidateContext(
        message,
        this.normalizeExtraction(extraction),
        resumeTargetJobTitle
      );
      const jobResolution = await this.resolveCandidateJob(message, contextualExtraction, resumeTargetJobTitle);
      if (!jobResolution.ok) return jobResolution.result;
      const job = jobResolution.job;
      let normalizedExtraction = { ...contextualExtraction, jobId: job.id, position: job.title };
      if (message.kind === "resume_pdf" && !resumeTargetJobTitle && contextualExtraction.position === "待确认岗位") {
        const pendingTask = await this.createJobConfirmationTask(
          message,
          "已解析简历，但没有识别到目标岗位。请用岗位ID确认后继续入库。",
          contextualExtraction.position,
          this.resumePendingContext(message)
        );
        return {
          message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id, extraction: contextualExtraction },
          pendingTask,
          replyText: this.buildJobConfirmationReply(pendingTask)
        };
      }
      if (message.kind === "resume_pdf") {
        const evaluation = await this.ai.evaluateResume({
          resumeText: message.attachment?.extractedText ?? message.content,
          candidate: normalizedExtraction,
          jobTitle: job.title,
          job
        });
        normalizedExtraction = {
          ...normalizedExtraction,
          matchScore: evaluation.matchScore,
          evaluation,
          risks: Array.from(new Set([...normalizedExtraction.risks, ...evaluation.risks]))
        };
      }
      const { candidate, task, created } = await this.repository.upsertCandidate(message, normalizedExtraction);
      const replyText = this.buildSuccessReply(candidate.name, candidate.position, candidate.owner, candidate.nextAction, created);
      return {
        message: { ...message, status: "parsed", parsedCandidateId: candidate.id, extraction: normalizedExtraction },
        candidate,
        task,
        webUrl: `${this.appBaseUrl}/candidates/${candidate.id}`,
        replyText: `${replyText}。详情：${this.appBaseUrl}/candidates/${candidate.id}`
      };
    } catch (error) {
      const messageError = error instanceof Error ? error.message : "未知解析错误";
      await this.repository.markMessageNeedsReview(message, messageError);
      return {
        message: { ...message, status: "needs_review", error: messageError },
        replyText: `已收到消息，但需要人工确认：${messageError}`
      };
    }
  }

  private async applyExistingCandidateContext(
    message: RawRecruitmentMessage,
    extraction: ExtractedRecruitmentInfo,
    resumeTargetJobTitle?: string
  ): Promise<ExtractedRecruitmentInfo> {
    if (message.kind === "resume_pdf" || resumeTargetJobTitle) return extraction;
    if (this.hasExplicitJobMention(message.content)) return extraction;
    const candidates = await this.repository.findCandidatesByName(extraction.candidateName);
    const existing = this.selectExistingCandidateForMutation(candidates, extraction);
    if (!existing) return extraction;
    const existingJob = existing.jobId
      ? await this.repository.getJob(existing.jobId)
      : await this.findKnownJobByTitle(existing.position);
    const existingPosition = this.isUnconfirmedPosition(existing.position)
      ? extraction.position
      : existingJob?.title ?? existing.position;
    return {
      ...extraction,
      candidateName: existing.name,
      jobId: existingJob?.id ?? existing.jobId,
      position: existingPosition,
      phone: extraction.phone ?? existing.phone,
      owner: extraction.owner ?? existing.owner,
      sourceGroup: extraction.sourceGroup ?? existing.sourceGroup,
      summary: this.mergeCandidateSummary(existing.summary, extraction.summary),
      risks: Array.from(new Set([...existing.risks, ...extraction.risks]))
    };
  }

  private normalizeExtraction(extraction: ExtractedRecruitmentInfo): ExtractedRecruitmentInfo {
    return {
      ...extraction,
      owner: this.normalizeOwner(extraction.owner)
    };
  }

  private normalizeOwner(owner: string | undefined): string | undefined {
    if (!owner) return undefined;
    const compact = owner.trim().replace(/[，,。；;：:\s]+$/g, "");
    if (!compact || /^(待确认|未知|无|暂无)/.test(compact)) return undefined;
    const explicit = compact.match(/^([\u4e00-\u9fa5A-Za-z]{1,8}?)(?:继续)?(?:负责|跟进|推进|记录|处理|对接)/)?.[1];
    const normalized = (explicit ?? compact)
      .replace(/(?:继续)?(?:负责|跟进|推进|记录|处理|对接).*$/u, "")
      .replace(/继续$/u, "")
      .trim();
    return normalized || undefined;
  }

  private async findKnownJobByTitle(title: string | undefined): Promise<JobRequirement | undefined> {
    if (!title || this.isUnconfirmedPosition(title)) return undefined;
    const matches = await this.repository.findJobsByTitle(title);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private isUnconfirmedPosition(position: string | undefined): boolean {
    return !position || position === "待确认岗位";
  }

  private mergeCandidateSummary(existingSummary: string, incomingSummary: string): string {
    const existing = existingSummary.trim();
    const incoming = incomingSummary.trim();
    if (!existing) return incoming;
    if (!incoming || existing.includes(incoming)) return existing;
    if (incoming.includes(existing)) return incoming;
    return `${incoming}；历史：${existing}`.slice(0, 180);
  }

  private selectExistingCandidateForMutation(
    candidates: Candidate[],
    extraction: ExtractedRecruitmentInfo
  ): Candidate | undefined {
    if (!candidates.length) return undefined;
    const exactNameCandidates = candidates.filter((candidate) => candidate.name === extraction.candidateName.trim());
    const pool = exactNameCandidates.length ? exactNameCandidates : candidates;
    if (pool.length === 1) return pool[0];

    const samePosition = pool.filter(
      (candidate) =>
        extraction.position !== "待确认岗位" &&
        (candidate.position === extraction.position ||
          candidate.position.includes(extraction.position) ||
          extraction.position.includes(candidate.position))
    );
    if (samePosition.length === 1) return samePosition[0];

    const withConfirmedJob = pool.filter((candidate) => candidate.jobId && candidate.position !== "待确认岗位");
    const preferredPool = withConfirmedJob.length ? withConfirmedJob : pool;
    return preferredPool.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  }

  private async handleJobRequirement(message: RawRecruitmentMessage): Promise<ProcessResult> {
    const parsed = await this.ai.parseJobRequirement(message.content);
    if (!parsed.title) {
      const pendingTask = await this.createPendingTask(
        message,
        "job_requirement",
        "我识别到你在补充岗位需求，但没有识别到岗位名称。",
        ["补充岗位名称"]
      );
      return {
        message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id },
        pendingTask,
        replyText: `${pendingTask.prompt} 任务 ${pendingTask.id}：请回复“${pendingTask.id} Java后端”。`
      };
    }
    const job = await this.repository.upsertJobRequirement(parsed);
    await this.repository.updateMessage({ ...message, status: "parsed", parsedJobId: job.id });
    return {
      message: { ...message, status: "parsed", parsedJobId: job.id },
      job,
      webUrl: `${this.appBaseUrl}/jobs/${job.id}`,
      replyText: `已更新岗位需求：${job.title}${job.targetHeadcount ? `，目标${job.targetHeadcount}人` : ""}${job.owner ? `，负责人${job.owner}` : ""}。详情：${this.appBaseUrl}/jobs/${job.id}`
    };
  }

  private async handleJobProgressQuery(message: RawRecruitmentMessage): Promise<ProcessResult> {
    const title = this.extractJobTitle(message.content);
    if (!title) {
      return this.handleUnknown(message, "请说明要查询哪个岗位，例如：Java后端现在招得怎么样了？");
    }
    const jobResolution = await this.resolveExistingJobForTask(message, title, "confirm_job_for_progress");
    if (!jobResolution.ok) return jobResolution.result;
    return this.buildJobProgressResult(message, jobResolution.job);
  }

  private async handleCandidateQuery(message: RawRecruitmentMessage): Promise<ProcessResult> {
    const name = this.extractCandidateName(message.content);
    if (!name) {
      return this.handleUnknown(message, "请说明要查询哪位候选人，例如：查一下张三进展。");
    }
    const candidates = await this.repository.findCandidatesByName(name);
    if (candidates.length === 0) {
      await this.repository.updateMessage({ ...message, status: "parsed" });
      return {
        message: { ...message, status: "parsed" },
        replyText: `没有查到候选人${name}。可以发送简历或面试反馈让我入库。`
      };
    }
    if (candidates.length > 1) {
      const pendingTask = await this.createPendingTask(
        message,
        "candidate_query",
        `找到多个${name}，请确认要查询哪一位。`,
        candidates.map((candidate) => `${candidate.name}/${candidate.position}/${candidate.stage}`),
        { candidateIds: candidates.map((candidate) => candidate.id) }
      );
      return {
        message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id },
        pendingTask,
        replyText: `${pendingTask.prompt} 任务 ${pendingTask.id}：${candidates.map((candidate, index) => `${index + 1}.${candidate.name}/${candidate.position}`).join(" ")}。请回复“${pendingTask.id} 选1”。`
      };
    }
    const candidate = candidates[0];
    await this.repository.updateMessage({ ...message, status: "parsed", parsedCandidateId: candidate.id });
    return {
      message: { ...message, status: "parsed", parsedCandidateId: candidate.id },
      candidate,
      webUrl: `${this.appBaseUrl}/candidates/${candidate.id}`,
      replyText: `${candidate.name}当前阶段：${candidate.stage}，岗位：${candidate.position}${candidate.owner ? `，${candidate.owner}跟进` : ""}。最近记录：${candidate.summary}。下一步：${candidate.nextAction}。详情：${this.appBaseUrl}/candidates/${candidate.id}`
    };
  }

  private async handleJdGenerate(message: RawRecruitmentMessage): Promise<ProcessResult> {
    const title = this.extractJobTitle(message.content);
    if (!title) return this.handleUnknown(message, "请说明要生成哪个岗位的JD。");
    const jobResolution = await this.resolveExistingJobForTask(message, title, "confirm_job_for_jd");
    if (!jobResolution.ok) return jobResolution.result;
    const job = jobResolution.job;
    const jdDraft = await this.ai.generateJd(job);
    const updated = await this.repository.updateJob(job.id, { jdDraft });
    await this.repository.updateMessage({ ...message, status: "parsed", parsedJobId: job.id });
    return {
      message: { ...message, status: "parsed", parsedJobId: job.id },
      job: updated ?? job,
      webUrl: `${this.appBaseUrl}/jobs/${job.id}`,
      replyText: `已生成${job.title} JD草稿，可在Web中继续编辑。详情：${this.appBaseUrl}/jobs/${job.id}`
    };
  }

  private async handleUnknown(message: RawRecruitmentMessage, prompt = "我不确定你要执行哪类招聘任务。"): Promise<ProcessResult> {
    const pendingTask = await this.createPendingTask(message, "unknown", prompt, [
      "解析简历",
      "记录面试反馈",
      "查询候选人",
      "查询岗位进度",
      "录入岗位需求"
    ]);
    return {
      message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id },
      pendingTask,
      replyText: `${prompt} 任务 ${pendingTask.id}：请回复“${pendingTask.id} 选1/选2/选3”。`
    };
  }

  private async resolvePendingReply(message: RawRecruitmentMessage, content: string): Promise<ProcessResult> {
    const id = content.match(/T\d{8}[A-Z0-9]{4}/)?.[0];
    if (!id) return this.handleUnknown(message);
    const pendingTask = await this.repository.getPendingTask(id);
    if (pendingTask?.context.action === "confirm_job_for_candidate") {
      return this.resolveJobConfirmation(message, pendingTask, content);
    }
    if (pendingTask?.context.action === "confirm_job_for_progress") {
      const job = await this.extractConfirmedJob(content, id);
      if (!job) return this.invalidJobConfirmation(message, pendingTask, id);
      await this.repository.resolvePendingTask(id);
      return this.buildJobProgressResult(message, job, pendingTask);
    }
    if (pendingTask?.context.action === "confirm_job_for_jd") {
      const job = await this.extractConfirmedJob(content, id);
      if (!job) return this.invalidJobConfirmation(message, pendingTask, id);
      await this.repository.resolvePendingTask(id);
      const jdDraft = await this.ai.generateJd(job);
      const updated = await this.repository.updateJob(job.id, { jdDraft });
      await this.repository.updateMessage({ ...message, status: "parsed", parsedJobId: job.id });
      return {
        message: { ...message, status: "parsed", parsedJobId: job.id },
        pendingTask: { ...pendingTask, status: "resolved", resolvedAt: new Date().toISOString() },
        job: updated ?? job,
        webUrl: `${this.appBaseUrl}/jobs/${job.id}`,
        replyText: `已按岗位ID确认并生成${job.title} JD草稿。详情：${this.appBaseUrl}/jobs/${job.id}`
      };
    }
    const resolvedTask = pendingTask ? await this.repository.resolvePendingTask(id) : undefined;
    const activePendingTask = resolvedTask ?? pendingTask;
    const selectedIndex = this.extractSelectedIndex(content);
    if (activePendingTask?.type === "resume_parse_match") {
      const jobTitle = this.extractPendingJobTitle(content, id);
      const attachment = activePendingTask.context.attachment as MessageAttachment | undefined;
      const resumeContent = String(activePendingTask.context.content ?? attachment?.extractedText ?? "").trim();
      if (!jobTitle) {
        await this.repository.updateMessage({ ...message, status: "needs_review", pendingTaskId: activePendingTask.id });
        return {
          message: { ...message, status: "needs_review", pendingTaskId: activePendingTask.id },
          pendingTask: activePendingTask,
          replyText: `请在任务 ${id} 后补充目标岗位，例如“${id} Java后端”。`
        };
      }
      if (!resumeContent || !attachment?.extractedText) {
        await this.repository.updateMessage({ ...message, status: "needs_review", pendingTaskId: activePendingTask.id });
        return {
          message: { ...message, status: "needs_review", pendingTaskId: activePendingTask.id },
          pendingTask: activePendingTask,
          replyText: `任务 ${id} 没有可继续处理的PDF文本，请重新发送PDF简历并注明目标岗位。`
        };
      }
      const result = await this.process({
        source: message.source,
        kind: "resume_pdf",
        content: resumeContent,
        sender: message.sender ?? activePendingTask.requesterId,
        groupName: message.groupName ?? activePendingTask.groupId,
        attachment: {
          ...attachment,
          jobTitle,
          extractedText: attachment.extractedText
        }
      });
      await this.repository.updateMessage({ ...message, status: "parsed", parsedCandidateId: result.candidate?.id });
      return {
        ...result,
        pendingTask: activePendingTask,
        replyText: `已按目标岗位“${jobTitle}”继续解析PDF简历。${result.replyText}`
      };
    }
    if (activePendingTask?.type === "job_progress_query" && selectedIndex !== undefined) {
      const jobIds = activePendingTask.context.jobIds as string[] | undefined;
      const jobId = jobIds?.[selectedIndex];
      if (jobId) {
        const progress = await this.repository.jobProgress(jobId);
        progress.summary = await this.ai.summarizeJobProgress(progress);
        await this.repository.updateMessage({ ...message, status: "parsed", parsedJobId: progress.job?.id });
        const jobUrl = progress.job ? `${this.appBaseUrl}/jobs/${progress.job.id}` : `${this.appBaseUrl}/jobs`;
        const excelUrl = progress.job ? `${this.appBaseUrl}/api/jobs/${progress.job.id}/export.xlsx` : undefined;
        return {
          message: { ...message, status: "parsed", parsedJobId: progress.job?.id },
          pendingTask: activePendingTask,
          progress,
          webUrl: jobUrl,
          excelUrl,
          replyText: `${progress.summary} 重点候选：${this.names(progress.keyCandidates.map((item) => item.candidate.name))}。风险候选：${this.names(progress.riskCandidates.map((item) => item.candidate.name))}。详情：${jobUrl}${excelUrl ? `，Excel：${excelUrl}` : ""}`
        };
      }
    }
    if (activePendingTask?.type === "candidate_query" && selectedIndex !== undefined) {
      const candidateIds = activePendingTask.context.candidateIds as string[] | undefined;
      const candidateId = candidateIds?.[selectedIndex];
      const candidate = candidateId ? await this.repository.getCandidate(candidateId) : undefined;
      if (candidate) {
        await this.repository.updateMessage({ ...message, status: "parsed", parsedCandidateId: candidate.id });
        return {
          message: { ...message, status: "parsed", parsedCandidateId: candidate.id },
          pendingTask: activePendingTask,
          candidate,
          webUrl: `${this.appBaseUrl}/candidates/${candidate.id}`,
          replyText: `${candidate.name}当前阶段：${candidate.stage}，岗位：${candidate.position}${candidate.owner ? `，${candidate.owner}跟进` : ""}。最近记录：${candidate.summary}。下一步：${candidate.nextAction}。详情：${this.appBaseUrl}/candidates/${candidate.id}`
        };
      }
    }
    await this.repository.updateMessage({ ...message, status: activePendingTask ? "parsed" : "needs_review" });
    return {
      message: { ...message, status: activePendingTask ? "parsed" : "needs_review" },
      pendingTask: activePendingTask,
      replyText: activePendingTask ? `已收到任务 ${id} 的确认，后续将按确认信息继续处理。` : `没有找到有效任务 ${id}，请确认任务是否已过期。`
    };
  }

  private async resolveCandidateJob(
    message: RawRecruitmentMessage,
    extraction: ExtractedRecruitmentInfo,
    resumeTargetJobTitle?: string
  ): Promise<{ ok: true; job: JobRequirement } | { ok: false; result: ProcessResult }> {
    if (extraction.jobId) {
      const job = await this.repository.getJob(extraction.jobId);
      if (job) return { ok: true, job };
    }
    const confirmedJobId = message.attachment?.jobId;
    if (confirmedJobId) {
      const job = await this.repository.getJob(confirmedJobId);
      if (job) return { ok: true, job };
    }
    const title = resumeTargetJobTitle ?? extraction.position;
    return this.resolveExistingJobForTask(message, title, "confirm_job_for_candidate", extraction);
  }

  private async resolveExistingJobForTask(
    message: RawRecruitmentMessage,
    title: string | undefined,
    action: "confirm_job_for_candidate" | "confirm_job_for_progress" | "confirm_job_for_jd",
    extraction?: ExtractedRecruitmentInfo
  ): Promise<{ ok: true; job: JobRequirement } | { ok: false; result: ProcessResult }> {
    const normalizedTitle = title?.trim();
    if (!normalizedTitle || normalizedTitle === "待确认岗位") {
      const pendingTask = await this.createJobConfirmationTask(
        message,
        "没有识别到可绑定的岗位，请用已存在岗位ID确认后继续执行。",
        normalizedTitle,
        { action, extraction }
      );
      await this.repository.updateMessage({ ...message, status: "needs_review", pendingTaskId: pendingTask.id, extraction });
      return {
        ok: false,
        result: {
          message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id, extraction },
          pendingTask,
          replyText: this.buildJobConfirmationReply(pendingTask)
        }
      };
    }

    const matches = await this.repository.findJobsByTitle(normalizedTitle);
    if (matches.length === 1) return { ok: true, job: matches[0] };

    const prompt =
      matches.length > 1
        ? `识别到岗位“${normalizedTitle}”，但匹配到多个已存在岗位，请用岗位ID确认。`
        : `识别到岗位“${normalizedTitle}”，但岗位库中不存在该岗位，请从已存在岗位中选择岗位ID后继续执行。`;
    const pendingTask = await this.createJobConfirmationTask(message, prompt, normalizedTitle, {
      action,
      extraction,
      matchedJobIds: matches.map((job) => job.id)
    });
    await this.repository.updateMessage({ ...message, status: "needs_review", pendingTaskId: pendingTask.id, extraction });
    return {
      ok: false,
      result: {
        message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id, extraction },
        pendingTask,
        replyText: this.buildJobConfirmationReply(pendingTask)
      }
    };
  }

  private async createJobConfirmationTask(
    message: RawRecruitmentMessage,
    prompt: string,
    extractedJobTitle?: string,
    context: Record<string, unknown> = {}
  ): Promise<PendingTask> {
    const matchedIds = Array.isArray(context.matchedJobIds) ? (context.matchedJobIds as string[]) : [];
    const candidates =
      matchedIds.length > 0
        ? (await Promise.all(matchedIds.map((id) => this.repository.getJob(id)))).filter(
            (job): job is JobRequirement => Boolean(job)
          )
        : await this.repository.findSimilarJobs(extractedJobTitle ?? "", 5);
    const options = candidates.map((job) => `${job.title}（岗位ID：${job.id}）`);
    return this.createPendingTask(message, (message.taskType ?? "resume_parse_match") as TaskType, prompt, options, {
      action: context.action ?? "confirm_job_for_candidate",
      extractedJobTitle,
      kind: message.kind,
      attachment: message.attachment,
      sender: message.sender,
      groupName: message.groupName,
      suggestedJobIds: candidates.map((job) => job.id),
      ...context
    });
  }

  private buildJobConfirmationReply(pendingTask: PendingTask): string {
    const options = pendingTask.options?.length
      ? pendingTask.options.map((option, index) => `${index + 1}.${option}`).join(" ")
      : "暂无可选岗位，请先在Web端录入岗位后再回复岗位ID。";
    return `${pendingTask.prompt} 任务 ${pendingTask.id}：${options} 请回复“${pendingTask.id} 岗位ID”。`;
  }

  private async resolveJobConfirmation(
    message: RawRecruitmentMessage,
    pendingTask: PendingTask,
    content: string
  ): Promise<ProcessResult> {
    const job = await this.extractConfirmedJob(content, pendingTask.id);
    if (!job) return this.invalidJobConfirmation(message, pendingTask, pendingTask.id);
    const attachment = pendingTask.context.attachment as MessageAttachment | undefined;
    const result = await this.process({
      source: message.source,
      kind: pendingTask.context.kind as RecruitmentMessageKind | undefined,
      content: String(pendingTask.context.content ?? attachment?.extractedText ?? ""),
      sender: message.sender ?? String(pendingTask.context.sender ?? ""),
      groupName: message.groupName ?? String(pendingTask.context.groupName ?? ""),
      attachment: {
        ...attachment,
        jobId: job.id,
        jobTitle: job.title,
        extractedText: attachment?.extractedText
      }
    });
    await this.repository.resolvePendingTask(pendingTask.id);
    await this.repository.updateMessage({
      ...message,
      status: "parsed",
      parsedCandidateId: result.candidate?.id,
      parsedJobId: job.id
    });
    return {
      ...result,
      pendingTask: { ...pendingTask, status: "resolved", resolvedAt: new Date().toISOString() },
      replyText: `已按岗位ID确认“${job.title}”，并继续执行原任务。${result.replyText}`
    };
  }

  private async extractConfirmedJob(content: string, taskId: string): Promise<JobRequirement | undefined> {
    const remainder = content.replace(taskId, "").replace(/^(岗位ID|岗位|jobId|job)[:：\s]*/i, "").trim();
    const jobs = await this.repository.listJobs();
    return jobs.find((job) => remainder.includes(job.id) || job.id.includes(remainder));
  }

  private async invalidJobConfirmation(
    message: RawRecruitmentMessage,
    pendingTask: PendingTask,
    taskId: string
  ): Promise<ProcessResult> {
    await this.repository.updateMessage({ ...message, status: "needs_review", pendingTaskId: pendingTask.id });
    return {
      message: { ...message, status: "needs_review", pendingTaskId: pendingTask.id },
      pendingTask,
      replyText: `没有识别到有效岗位ID。${this.buildJobConfirmationReply({ ...pendingTask, id: taskId })}`
    };
  }

  private async buildJobProgressResult(
    message: RawRecruitmentMessage,
    job: JobRequirement,
    pendingTask?: PendingTask
  ): Promise<ProcessResult> {
    const progress = await this.repository.jobProgress(job.id);
    progress.summary = await this.ai.summarizeJobProgress(progress);
    await this.repository.updateMessage({ ...message, status: "parsed", parsedJobId: job.id });
    const jobUrl = `${this.appBaseUrl}/jobs/${job.id}`;
    const excelUrl = `${this.appBaseUrl}/api/jobs/${job.id}/export.xlsx`;
    return {
      message: { ...message, status: "parsed", parsedJobId: job.id },
      pendingTask,
      progress,
      webUrl: jobUrl,
      excelUrl,
      replyText: `${progress.summary} 重点候选：${this.names(progress.keyCandidates.map((item) => item.candidate.name))}。风险候选：${this.names(progress.riskCandidates.map((item) => item.candidate.name))}。详情：${jobUrl}，Excel：${excelUrl}`
    };
  }

  private createPendingTask(
    message: RawRecruitmentMessage,
    type: TaskType,
    prompt: string,
    options?: string[],
    context: Record<string, unknown> = {}
  ): Promise<PendingTask> {
    return this.repository.createPendingTask({
      type,
      groupId: message.groupName,
      requesterId: message.sender,
      originalMessageId: message.messageId ?? message.id,
      prompt,
      options,
      context: { messageId: message.id, content: message.content, ...context }
    });
  }

  private detectKind(content: string, fileName?: string): RecruitmentMessageKind {
    if (fileName?.toLowerCase().endsWith(".pdf")) return "resume_pdf";
    if (/反馈|评价|面评|面试官|通过|不通过|二面|三面/.test(content)) return "interview_feedback";
    return "text";
  }

  private async buildAiInput(message: RawRecruitmentMessage): Promise<string> {
    const databaseLookupInstruction = [
      "数据库查询工具使用规则：",
      "1. 如果不确定候选人姓名，不要把“一面、二面、反馈、通过、淘汰”等面试状态词并入姓名。",
      "2. 如果消息里疑似提到已有候选人，请优先按已有候选人姓名理解，例如“张三一面表现不错”中的姓名是“张三”。",
      "3. 如果不确定岗位，不要编造岗位；岗位缺失时写“待确认岗位”，后续系统会查询岗位库并生成确认任务。",
      "4. 如果候选人或岗位可能已存在，系统会查询数据库候选人和岗位列表，请配合返回最可能的真实姓名和岗位。"
    ].join("\n");
    const databaseContext = await this.buildDatabaseContext(message.content);
    if (message.kind === "resume_pdf") {
      return [
        databaseLookupInstruction,
        databaseContext,
        "以下内容来自候选人PDF简历或附件，请抽取候选人基础信息、风险点，并给出招聘跟进动作。",
        `目标岗位：${this.resumeTargetJobTitle(message) ?? "未指定"}`,
        `文件名：${message.attachment?.fileName ?? "未知PDF"}`,
        message.attachment?.extractedText ?? message.content
      ].join("\n\n");
    }
    if (message.taskType === "interview_feedback") {
      return [
        databaseLookupInstruction,
        databaseContext,
        "以下内容是面试反馈，请重点判断候选人当前阶段、面试结论、风险点和下一步动作。",
        "姓名抽取少样本：",
        "输入：张三一面表现不错，Java基础扎实，安排二面。输出：candidateName=张三，position=待确认岗位，stage=interviewing。",
        "输入：李四二面表现不错，沟通清晰。输出：candidateName=李四，position=待确认岗位，stage=interviewing。",
        "输入：王五淘汰，项目经验不匹配。输出：candidateName=王五，position=待确认岗位，stage=rejected。",
        message.content
      ].join("\n\n");
    }
    return [
      databaseLookupInstruction,
      databaseContext,
      "普通群消息抽取少样本：",
      "输入：张三 Java后端候选人，明天下午3点一面，王工跟进，手机号13800138000。输出：candidateName=张三，position=Java后端，stage=interview_scheduled，owner=王工。",
      "输入：张三一面不错，表达能力清晰。输出：candidateName=张三，position=待确认岗位，stage=interviewing。",
      "输入：Java后端候选人不错。输出：candidateName=待确认候选人，position=Java后端。",
      message.content
    ].join("\n\n");
  }

  private async buildDatabaseContext(content: string): Promise<string> {
    const candidateName = this.extractCandidateName(content);
    const jobTitle = this.extractJobTitle(content);
    const [candidates, jobs] = await Promise.all([
      candidateName ? this.repository.findCandidatesByName(candidateName) : Promise.resolve([]),
      jobTitle ? this.repository.findSimilarJobs(jobTitle, 5) : this.repository.listJobs()
    ]);
    return [
      "数据库查询结果：",
      candidates.length
        ? `相似候选人：${candidates.map((candidate) => `${candidate.name}/${candidate.position}/${candidate.stage}`).join("；")}`
        : "相似候选人：无",
      jobs.length ? `可用岗位：${jobs.map((job) => `${job.title}(岗位ID:${job.id})`).join("；")}` : "可用岗位：无",
      "如果消息中的人名或岗位与上述记录相近，请优先使用数据库中的真实姓名和岗位名称。"
    ].join("\n");
  }

  private extractJobTitle(content: string): string {
    const clean = content.replace(/@\S+\s?/g, "");
    return (
      clean.match(/([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,20})(?:岗位|岗|职位)/)?.[1] ??
      clean.match(/(Java后端|Go后端|Python后端|前端|产品经理|测试工程师|运营|研发)/i)?.[1] ??
      ""
    );
  }

  private hasExplicitJobMention(content: string): boolean {
    const clean = content.replace(/@\S+\s?/g, "");
    return /(Java后端|Go后端|Python后端|前端|产品经理|测试工程师|运营|研发)|([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,20})(?:岗位|岗|职位)/i.test(
      clean
    );
  }

  private extractCandidateName(content: string): string {
    const clean = content.replace(/@\S+\s?/g, "").replace(/查一下|查询|进展|现在|到哪一步|候选人/g, "").trim();
    return clean.match(/([\u4e00-\u9fa5]{2,4})/)?.[1] ?? "";
  }

  private buildSuccessReply(
    name: string,
    position: string,
    owner: string | undefined,
    nextAction: string,
    created: boolean
  ): string {
    return [
      created ? `已记录候选人${name}` : `已更新候选人${name}`,
      `岗位：${position}`,
      owner ? `负责人：${owner}` : undefined,
      `下一步：${nextAction}`
    ]
      .filter(Boolean)
      .join("，");
  }

  private resumeTargetJobTitle(message: RawRecruitmentMessage): string | undefined {
    const jobTitle = message.attachment?.jobTitle?.trim();
    return jobTitle || undefined;
  }

  private resumePendingContext(message: RawRecruitmentMessage): Record<string, unknown> {
    return {
      kind: message.kind,
      attachment: message.attachment,
      sender: message.sender,
      groupName: message.groupName
    };
  }

  private isPendingTaskReply(content: string): boolean {
    return /T\d{8}[A-Z0-9]{4}/.test(content);
  }

  private names(values: string[]): string {
    return values.length ? values.join("、") : "暂无";
  }

  private extractSelectedIndex(content: string): number | undefined {
    const value = content.match(/选\s*(\d+)/)?.[1];
    if (!value) return undefined;
    return Math.max(Number(value) - 1, 0);
  }

  private extractPendingJobTitle(content: string, taskId: string): string {
    return content
      .replace(taskId, "")
      .replace(/^(目标岗位|岗位|应聘岗位)[:：\s]*/u, "")
      .trim();
  }
}

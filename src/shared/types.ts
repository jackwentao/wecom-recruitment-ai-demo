export type RecruitmentStage =
  | "new"
  | "screening"
  | "interview_scheduled"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn"
  | "manual_review";

export type MessageStatus = "received" | "parsed" | "needs_review" | "failed";
export type RecruitmentMessageKind = "text" | "interview_feedback" | "resume_pdf" | "file";

export type TaskType =
  | "resume_parse_match"
  | "interview_feedback"
  | "candidate_query"
  | "job_requirement"
  | "job_progress_query"
  | "jd_generate"
  | "schedule_update"
  | "followup_reminder"
  | "unknown";

export interface MessageAttachment {
  fileName?: string;
  jobId?: string;
  jobTitle?: string;
  mediaId?: string;
  mimeType?: string;
  size?: number;
  extractedText?: string;
  extractionError?: string;
}

export interface RawRecruitmentMessage {
  id: string;
  source: "wecom_aibot" | "local_simulator";
  kind: RecruitmentMessageKind;
  taskType?: TaskType;
  content: string;
  sender?: string;
  groupName?: string;
  messageId?: string;
  attachment?: MessageAttachment;
  receivedAt: string;
  status: MessageStatus;
  error?: string;
  parsedCandidateId?: string;
  parsedJobId?: string;
  pendingTaskId?: string;
  extraction?: ExtractedRecruitmentInfo;
  replyText?: string;
}

export interface ExtractedRecruitmentInfo {
  candidateName: string;
  phone?: string;
  jobId?: string;
  position: string;
  stage: RecruitmentStage;
  interviewTime?: string;
  owner?: string;
  sourceGroup?: string;
  summary: string;
  risks: string[];
  nextAction: string;
  confidence: number;
  resumeProfile?: ResumeProfile;
  matchScore?: number;
  evaluation?: ResumeEvaluation;
}

export interface ResumeEducation {
  school?: string;
  degree?: string;
  major?: string;
  period?: string;
  educationLevel?: string;
}

export interface ResumeExperience {
  company?: string;
  role?: string;
  period?: string;
  description?: string;
  highlights: string[];
}

export interface ResumeProject {
  name?: string;
  role?: string;
  period?: string;
  description?: string;
  techStack: string[];
  highlights: string[];
}

export interface ResumeProfile {
  email?: string;
  location?: string;
  birthDate?: string;
  workYears?: string;
  education: ResumeEducation[];
  internships: ResumeExperience[];
  workExperiences: ResumeExperience[];
  projects: ResumeProject[];
  skills: string[];
  certificates: string[];
  languages: string[];
  rawHighlights: string[];
}

export type RecommendationLevel = "strong_match" | "match" | "weak_match" | "not_match";

export interface AbilityAssessment {
  technical: number;
  project: number;
  domain: number;
  communication: number;
  stability: number;
}

export interface ResumeEvaluation {
  matchScore: number;
  recommendation: RecommendationLevel;
  abilityAssessment: AbilityAssessment;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  interviewFocus: string[];
  summary: string;
}

export interface CandidateTimelineItem {
  id: string;
  messageId: string;
  content: string;
  createdAt: string;
  summary: string;
}

export interface Candidate {
  id: string;
  name: string;
  phone?: string;
  jobId?: string;
  position: string;
  stage: RecruitmentStage;
  owner?: string;
  sourceGroup?: string;
  interviewTime?: string;
  summary: string;
  risks: string[];
  nextAction: string;
  confidence: number;
  resumeProfile?: ResumeProfile;
  matchScore?: number;
  evaluation?: ResumeEvaluation;
  createdAt: string;
  updatedAt: string;
  timeline: CandidateTimelineItem[];
}

export interface FollowUpTask {
  id: string;
  candidateId: string;
  title: string;
  owner?: string;
  dueAt?: string;
  status: "open" | "done";
  createdAt: string;
}

export interface JobRequirement {
  id: string;
  title: string;
  targetHeadcount?: number;
  owner?: string;
  requirements: string[];
  supplements: string[];
  jdDraft?: string;
  status: "open" | "paused" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface JobProgress {
  job?: JobRequirement;
  title: string;
  targetHeadcount?: number;
  totalCandidates: number;
  effectiveCandidates: number;
  offerCandidates: number;
  gap?: number;
  stageCounts: Record<RecruitmentStage, number>;
  candidates: Candidate[];
  keyCandidates: CandidateScore[];
  riskCandidates: CandidateRisk[];
  summary: string;
}

export interface CandidateScore {
  candidate: Candidate;
  priorityScore: number;
  reasons: string[];
}

export interface CandidateRisk {
  candidate: Candidate;
  riskLevel: "high" | "medium" | "low";
  reasons: string[];
}

export interface PendingTask {
  id: string;
  type: TaskType;
  groupId?: string;
  requesterId?: string;
  originalMessageId?: string;
  status: "waiting" | "resolved" | "expired";
  prompt: string;
  options?: string[];
  context: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface DashboardMetrics {
  totalCandidates: number;
  openTasks: number;
  overdueTasks: number;
  parseSuccessRate: number;
  stageCounts: Record<RecruitmentStage, number>;
}

export interface AppData {
  messages: RawRecruitmentMessage[];
  candidates: Candidate[];
  tasks: FollowUpTask[];
  jobs: JobRequirement[];
  pendingTasks: PendingTask[];
}

export interface ProcessResult {
  message: RawRecruitmentMessage;
  candidate?: Candidate;
  task?: FollowUpTask;
  job?: JobRequirement;
  progress?: JobProgress;
  pendingTask?: PendingTask;
  replyText: string;
  webUrl?: string;
  excelUrl?: string;
}

export const stageLabels: Record<RecruitmentStage, string> = {
  new: "新线索",
  screening: "简历筛选",
  interview_scheduled: "已约面",
  interviewing: "面试中",
  offer: "Offer",
  rejected: "淘汰",
  withdrawn: "放弃",
  manual_review: "待人工确认"
};

export const taskTypeLabels: Record<TaskType, string> = {
  resume_parse_match: "简历解析与匹配",
  interview_feedback: "面试反馈",
  candidate_query: "候选人查询",
  job_requirement: "岗位需求",
  job_progress_query: "岗位进度查询",
  jd_generate: "JD生成",
  schedule_update: "日程更新",
  followup_reminder: "跟进提醒",
  unknown: "待确认任务"
};

export const effectiveStages: RecruitmentStage[] = [
  "new",
  "screening",
  "interview_scheduled",
  "interviewing",
  "offer"
];

import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock,
  KanbanSquare,
  MessageSquareText,
  RefreshCw,
  Send,
  FileText,
  FileSpreadsheet,
  Trash2,
  Users
} from "lucide-react";
import type { Candidate, DashboardMetrics, JobProgress, JobRequirement, RawRecruitmentMessage, RecruitmentStage } from "../shared/types";
import { stageLabels } from "../shared/types";
import "./styles.css";

const api = {
  async getMessages(): Promise<RawRecruitmentMessage[]> {
    return fetch("/api/messages").then((res) => res.json());
  },
  async getCandidates(): Promise<Candidate[]> {
    return fetch("/api/candidates").then((res) => res.json());
  },
  async getMetrics(): Promise<DashboardMetrics> {
    return fetch("/api/dashboard/metrics").then((res) => res.json());
  },
  async getJobs(): Promise<JobRequirement[]> {
    return fetch("/api/jobs").then((res) => res.json());
  },
  async getJob(id: string): Promise<{ job: JobRequirement; progress: JobProgress }> {
    return fetch(`/api/jobs/${id}`).then((res) => res.json());
  },
  async createJob(input: { title: string; targetHeadcount?: number; owner?: string; supplement?: string }) {
    return fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    }).then((res) => res.json());
  },
  async simulate(content: string) {
    return fetch("/api/messages/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, sender: "Web演示", groupName: "招聘内部协作群" })
    }).then((res) => res.json());
  },
  async uploadPdf(file: File, jobTitle: string) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("jobTitle", jobTitle);
    formData.append("sender", "Web上传");
    formData.append("groupName", "招聘内部协作群");
    const response = await fetch("/api/messages/upload-pdf", {
      method: "POST",
      body: formData
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "PDF上传失败");
    return result;
  },
  async clearDemoData() {
    return fetch("/api/demo-data", {
      method: "DELETE"
    }).then((res) => res.json());
  }
};

const stageOrder: RecruitmentStage[] = [
  "new",
  "screening",
  "interview_scheduled",
  "interviewing",
  "offer",
  "manual_review"
];

const sampleMessages = [
  {
    label: "录入候选人",
    content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，简历不错，王工跟进，手机号13800138000"
  },
  {
    label: "面试反馈",
    content: "@招聘助手 张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面，王工继续跟进"
  },
  {
    label: "岗位需求",
    content: "@招聘助手 Java后端岗位招3人，王工负责，要求3年以上经验，熟悉Spring Boot、MySQL、Redis和微服务"
  },
  {
    label: "进度查询",
    content: "@招聘助手 Java后端现在招得怎么样了？"
  },
  {
    label: "生成JD",
    content: "@招聘助手 生成Java后端岗位JD"
  },
  {
    label: "候选人查询",
    content: "@招聘助手 查一下张三进展"
  },
  {
    label: "淘汰/风险",
    content: "@招聘助手 王珊测试工程师候选人不合适，沟通后淘汰，周敏记录原因"
  }
];

function App() {
  const [messages, setMessages] = useState<RawRecruitmentMessage[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [jobs, setJobs] = useState<JobRequirement[]>([]);
  const [selectedJob, setSelectedJob] = useState<{ job: JobRequirement; progress: JobProgress } | null>(null);
  const [jobForm, setJobForm] = useState({ title: "Java后端", targetHeadcount: "3", owner: "王工", supplement: "3年以上经验，熟悉Spring Boot和微服务" });
  const [content, setContent] = useState(sampleMessages[0].content);
  const [pdfJobTitle, setPdfJobTitle] = useState("");
  const [selectedPdf, setSelectedPdf] = useState<File | null>(null);
  const [actionNotice, setActionNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);

  const refresh = async () => {
    const [nextMessages, nextCandidates, nextMetrics, nextJobs] = await Promise.all([
      api.getMessages(),
      api.getCandidates(),
      api.getMetrics(),
      api.getJobs()
    ]);
    setMessages(nextMessages);
    setCandidates(nextCandidates);
    setMetrics(nextMetrics);
    setJobs(nextJobs);
    if (selectedCandidate) {
      setSelectedCandidate(nextCandidates.find((item) => item.id === selectedCandidate.id) ?? null);
    }
    if (selectedJob) {
      const exists = nextJobs.find((item) => item.id === selectedJob.job.id);
      if (exists) setSelectedJob(await api.getJob(exists.id));
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const groupedCandidates = useMemo(
    () =>
      stageOrder.map((stage) => ({
        stage,
        items: candidates.filter((candidate) => candidate.stage === stage)
      })),
    [candidates]
  );

  const sendDemoMessage = async () => {
    if (!content.trim()) return;
    setActionNotice("");
    setLoading(true);
    try {
      const result = await api.simulate(content);
      setActionNotice(result.replyText ?? "群消息已提交。");
      await refresh();
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "群消息提交失败。");
    } finally {
      setLoading(false);
    }
  };

  const uploadPdf = async () => {
    if (!selectedPdf) {
      setActionNotice("请先选择PDF简历文件。");
      return;
    }
    if (!pdfJobTitle.trim()) {
      setActionNotice("请先填写目标岗位。目标岗位必须是已存在岗位。");
      return;
    }
    setActionNotice("");
    setLoading(true);
    try {
      const result = await api.uploadPdf(selectedPdf, pdfJobTitle.trim());
      setActionNotice(result.replyText ?? "PDF简历已提交解析。");
      setSelectedPdf(null);
      await refresh();
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "PDF简历上传失败。");
    } finally {
      setLoading(false);
    }
  };

  const createJob = async () => {
    if (!jobForm.title.trim()) return;
    setLoading(true);
    try {
      const job = await api.createJob({
        title: jobForm.title,
        targetHeadcount: jobForm.targetHeadcount ? Number(jobForm.targetHeadcount) : undefined,
        owner: jobForm.owner,
        supplement: jobForm.supplement
      });
      setSelectedJob(await api.getJob(job.id));
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  const selectJob = async (id: string) => {
    setSelectedJob(await api.getJob(id));
  };

  const clearDemoData = async () => {
    const confirmed = window.confirm("确定清空所有演示数据吗？候选人、消息、岗位、待办都会删除。");
    if (!confirmed) return;
    setLoading(true);
    try {
      await api.clearDemoData();
      setSelectedCandidate(null);
      setSelectedJob(null);
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">企业微信群真实链路 AI Demo</p>
          <h1>招聘 AI 跟进助手</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button danger" disabled={loading} onClick={() => void clearDemoData()} title="清空演示数据">
            <Trash2 size={18} />
          </button>
          <button className="icon-button" onClick={() => void refresh()} title="刷新数据">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="metrics">
        <Metric icon={<Users />} label="候选人" value={metrics?.totalCandidates ?? 0} />
        <Metric icon={<Clock />} label="待办" value={metrics?.openTasks ?? 0} />
        <Metric icon={<AlertCircle />} label="超时" value={metrics?.overdueTasks ?? 0} />
        <Metric icon={<CheckCircle2 />} label="解析成功率" value={`${metrics?.parseSuccessRate ?? 0}%`} />
      </section>

      <section className="panel jobs-panel">
        <div className="panel-title">
          <FileSpreadsheet size={18} />
          <h2>岗位进度与JD</h2>
        </div>
        <div className="job-layout">
          <div className="job-form">
            <input value={jobForm.title} onChange={(event) => setJobForm({ ...jobForm, title: event.target.value })} placeholder="岗位名称" />
            <input value={jobForm.targetHeadcount} onChange={(event) => setJobForm({ ...jobForm, targetHeadcount: event.target.value })} placeholder="目标人数" />
            <input value={jobForm.owner} onChange={(event) => setJobForm({ ...jobForm, owner: event.target.value })} placeholder="负责人" />
            <input value={jobForm.supplement} onChange={(event) => setJobForm({ ...jobForm, supplement: event.target.value })} placeholder="需求/JD补充信息" />
            <button className="primary compact" disabled={loading} onClick={() => void createJob()}>
              保存岗位
            </button>
          </div>
          <div className="job-list">
            {jobs.map((job) => (
              <button key={job.id} className="job-item" onClick={() => void selectJob(job.id)}>
                <strong>{job.title}</strong>
                <span>目标 {job.targetHeadcount ?? "未录入"} 人 · {job.owner ?? "待分配"}</span>
              </button>
            ))}
          </div>
          <div className="job-detail">
            {selectedJob ? (
              <>
                <h3>{selectedJob.job.title}</h3>
                <p>{selectedJob.progress.summary}</p>
                <div className="job-stats">
                  <span>有效候选 {selectedJob.progress.effectiveCandidates}</span>
                  <span>Offer {selectedJob.progress.offerCandidates}</span>
                  <span>风险 {selectedJob.progress.riskCandidates.length}</span>
                </div>
                <h4>重点候选人</h4>
                <p>{selectedJob.progress.keyCandidates.map((item) => item.candidate.name).join("、") || "暂无"}</p>
                <h4>风险候选人</h4>
                <p>{selectedJob.progress.riskCandidates.map((item) => `${item.candidate.name}(${item.riskLevel})`).join("、") || "暂无"}</p>
                <a className="download-link" href={`/api/jobs/${selectedJob.job.id}/export.xlsx`}>
                  下载 Excel
                </a>
              </>
            ) : (
              <p className="muted">选择一个岗位查看进度、重点候选人、风险候选人和 Excel 输出。</p>
            )}
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="panel message-panel">
          <div className="panel-title">
            <MessageSquareText size={18} />
            <h2>群消息流</h2>
          </div>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            aria-label="模拟企业微信群消息"
          />
          <div className="samples">
            {sampleMessages.map((sample) => (
              <button key={sample.label} title={sample.content} onClick={() => setContent(sample.content)}>
                {sample.label}
              </button>
            ))}
          </div>
          <button className="primary" disabled={loading} onClick={() => void sendDemoMessage()}>
            <Send size={16} />
            {loading ? "处理中" : "发送群消息"}
          </button>
          <div className="pdf-upload">
            <input
              value={pdfJobTitle}
              onChange={(event) => setPdfJobTitle(event.target.value)}
              placeholder="PDF简历目标岗位（必填）"
              aria-label="PDF简历目标岗位"
            />
            <label className="upload-control">
              <FileText size={16} />
              <span>{selectedPdf ? selectedPdf.name : "选择 PDF 文件"}</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => setSelectedPdf(event.target.files?.[0] ?? null)}
              />
            </label>
            <button className="primary secondary-action" disabled={loading || !selectedPdf || !pdfJobTitle.trim()} onClick={() => void uploadPdf()}>
              {loading ? "解析中" : "解析 PDF 简历"}
            </button>
          </div>
          {actionNotice ? <p className="action-notice">{actionNotice}</p> : null}
          <div className="message-list">
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.status}`}>
                <div className="message-meta">
                  <strong>{message.sender ?? "企业微信成员"}</strong>
                  <span>{new Date(message.receivedAt).toLocaleString()}</span>
                </div>
                <p>{message.content}</p>
                <small>
                  {kindText(message.kind)} · {statusText(message.status)}
                </small>
                {message.replyText ? (
                  <div className="bot-reply">
                    <strong>AI助手回复</strong>
                    <p>{message.replyText}</p>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </aside>

        <section className="panel kanban-panel">
          <div className="panel-title">
            <KanbanSquare size={18} />
            <h2>候选人看板</h2>
          </div>
          <div className="kanban">
            {groupedCandidates.map(({ stage, items }) => (
              <div className="column" key={stage}>
                <div className="column-title">
                  <span>{stageLabels[stage]}</span>
                  <b>{items.length}</b>
                </div>
                {items.map((candidate) => (
                  <button className="candidate-card" key={candidate.id} onClick={() => setSelectedCandidate(candidate)}>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.position}</span>
                    {candidate.matchScore !== undefined ? <small>匹配度 {candidate.matchScore}</small> : null}
                    <small>{candidate.owner ? `${candidate.owner}跟进` : "待分配负责人"}</small>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>

        <aside className="panel detail-panel">
          <div className="panel-title">
            <Bot size={18} />
            <h2>AI 摘要</h2>
          </div>
          {selectedCandidate ? (
            <CandidateDetail candidate={selectedCandidate} />
          ) : (
            <div className="empty-state">
              <BarChart3 size={42} />
              <p>选择一个候选人查看时间线、风险和下一步动作。</p>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <article className="metric">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function CandidateDetail({ candidate }: { candidate: Candidate }) {
  const profile = candidate.resumeProfile;

  return (
    <div className="candidate-detail">
      <h3>{candidate.name}</h3>
      <dl>
        <div>
          <dt>岗位</dt>
          <dd>{candidate.position}</dd>
        </div>
        <div>
          <dt>阶段</dt>
          <dd>{stageLabels[candidate.stage]}</dd>
        </div>
        <div>
          <dt>负责人</dt>
          <dd>{candidate.owner ?? "待确认"}</dd>
        </div>
        <div>
          <dt>面试时间</dt>
          <dd>{candidate.interviewTime ?? "待确认"}</dd>
        </div>
      </dl>
      <section>
        <h4>AI 总结</h4>
        <p>{candidate.summary}</p>
      </section>
      {profile ? (
        <section>
          <h4>简历画像</h4>
          <div className="profile-grid">
            <div>
              <span>学校</span>
              <b>{profile.education.map((item) => [item.school, item.major].filter(Boolean).join(" / ")).filter(Boolean).join("、") || "未提取"}</b>
            </div>
            <div>
              <span>所在地</span>
              <b>{profile.location ?? "未提取"}</b>
            </div>
            <div>
              <span>工作年限</span>
              <b>{profile.workYears ?? "未提取"}</b>
            </div>
            <div>
              <span>邮箱</span>
              <b>{profile.email ?? "未提取"}</b>
            </div>
          </div>
          <ProfileList title="技能" values={profile.skills} />
          <ProfileList title="实习经历" values={profile.internships.map(formatExperience)} />
          <ProfileList title="工作经历" values={profile.workExperiences.map(formatExperience)} />
          <ProfileList title="项目经历" values={profile.projects.map(formatProject)} />
        </section>
      ) : null}
      {candidate.evaluation ? (
        <section>
          <h4>简历匹配评估</h4>
          <div className="evaluation-score">
            <strong>{candidate.evaluation.matchScore}</strong>
            <span>{recommendationText(candidate.evaluation.recommendation)}</span>
          </div>
          <p>{candidate.evaluation.summary}</p>
          <div className="ability-grid">
            {Object.entries(candidate.evaluation.abilityAssessment).map(([key, value]) => (
              <div key={key}>
                <span>{abilityText(key)}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
          <p>优势：{candidate.evaluation.strengths.length ? candidate.evaluation.strengths.join("、") : "暂无"}</p>
          <p>短板：{candidate.evaluation.weaknesses.length ? candidate.evaluation.weaknesses.join("、") : "暂无"}</p>
          <p>面试关注：{candidate.evaluation.interviewFocus.length ? candidate.evaluation.interviewFocus.join("、") : "暂无"}</p>
        </section>
      ) : null}
      <section>
        <h4>下一步</h4>
        <p>{candidate.nextAction}</p>
      </section>
      <section>
        <h4>风险</h4>
        <p>{candidate.risks.length ? candidate.risks.join("、") : "暂无明显风险"}</p>
      </section>
      <section>
        <h4>跟进时间线</h4>
        <div className="timeline">
          {candidate.timeline.map((item) => (
            <article key={item.id}>
              <time>{new Date(item.createdAt).toLocaleString()}</time>
              <p>{item.summary}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProfileList({ title, values }: { title: string; values: string[] }) {
  const normalized = values.filter(Boolean);
  if (!normalized.length) return null;
  return (
    <div className="profile-list">
      <strong>{title}</strong>
      <ul>
        {normalized.map((value, index) => (
          <li key={`${title}-${index}`}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

function formatExperience(item: NonNullable<Candidate["resumeProfile"]>["internships"][number]) {
  return [
    [item.company, item.role, item.period].filter(Boolean).join(" / "),
    item.description,
    item.highlights.length ? item.highlights.join("、") : undefined
  ]
    .filter(Boolean)
    .join("：");
}

function formatProject(item: NonNullable<Candidate["resumeProfile"]>["projects"][number]) {
  return [
    [item.name, item.role, item.period].filter(Boolean).join(" / "),
    item.techStack.length ? `技术栈：${item.techStack.join("、")}` : undefined,
    item.description,
    item.highlights.length ? item.highlights.join("、") : undefined
  ]
    .filter(Boolean)
    .join("；");
}

function statusText(status: RawRecruitmentMessage["status"]) {
  if (status === "parsed") return "已解析入库";
  if (status === "needs_review") return "待人工确认";
  if (status === "failed") return "解析失败";
  return "已接收";
}

function kindText(kind: RawRecruitmentMessage["kind"]) {
  if (kind === "resume_pdf") return "PDF简历";
  if (kind === "interview_feedback") return "面试反馈";
  if (kind === "file") return "附件";
  return "群文本";
}

function recommendationText(value: NonNullable<Candidate["evaluation"]>["recommendation"]) {
  if (value === "strong_match") return "强匹配";
  if (value === "match") return "匹配";
  if (value === "weak_match") return "弱匹配";
  return "不匹配";
}

function abilityText(value: string) {
  const labels: Record<string, string> = {
    technical: "技术",
    project: "项目",
    domain: "领域",
    communication: "沟通",
    stability: "稳定"
  };
  return labels[value] ?? value;
}

createRoot(document.getElementById("root")!).render(<App />);

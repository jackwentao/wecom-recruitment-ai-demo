import axios from "axios";
import { z } from "zod";
import type {
  ExtractedRecruitmentInfo,
  JobProgress,
  JobRequirement,
  RecruitmentMessageKind,
  RecruitmentStage,
  ResumeEvaluation,
  TaskType
} from "../../shared/types";

export interface AiExtractor {
  extract(message: string, context?: { sender?: string; groupName?: string }): Promise<ExtractedRecruitmentInfo>;
}

export interface ClassifiedTask {
  type: TaskType;
  confidence: number;
  reason?: string;
  jobTitle?: string;
  candidateName?: string;
}

export interface ParsedJobRequirement {
  title: string;
  targetHeadcount?: number;
  owner?: string;
  requirements: string[];
  supplement?: string;
}

export interface RecruitmentAi extends AiExtractor {
  classifyTask(input: {
    content: string;
    kind: RecruitmentMessageKind;
    fileName?: string;
    sender?: string;
    groupName?: string;
  }): Promise<ClassifiedTask>;
  parseJobRequirement(content: string): Promise<ParsedJobRequirement>;
  evaluateResume(input: {
    resumeText: string;
    candidate: ExtractedRecruitmentInfo;
    jobTitle: string;
    job?: JobRequirement;
  }): Promise<ResumeEvaluation>;
  generateJd(job: JobRequirement): Promise<string>;
  summarizeJobProgress(progress: JobProgress): Promise<string>;
}

const stageValues: RecruitmentStage[] = [
  "new",
  "screening",
  "interview_scheduled",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "manual_review"
];

const blankToUndefined = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "") ? undefined : value;
const nullToEmptyArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : value === null ? [] : value;
const nullToEmptyObjectArray = (value: unknown) => (Array.isArray(value) ? value : value === null ? [] : value);
const optionalStringSchema = z.preprocess(blankToUndefined, z.string().min(1).optional());
const optionalNumberSchema = z.preprocess(blankToUndefined, z.number().optional());
const stringArraySchema = z.preprocess(nullToEmptyArray, z.array(z.string()).default([]));
const scoreSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return value;
}, z.number().min(0).max(100));

const resumeEvaluationSchema = z.object({
  matchScore: scoreSchema,
  recommendation: z.enum(["strong_match", "match", "weak_match", "not_match"]),
  abilityAssessment: z.object({
    technical: scoreSchema,
    project: scoreSchema,
    domain: scoreSchema,
    communication: scoreSchema,
    stability: scoreSchema
  }),
  strengths: stringArraySchema,
  weaknesses: stringArraySchema,
  risks: stringArraySchema,
  interviewFocus: stringArraySchema,
  summary: z.string().min(1)
});

const resumeEducationSchema = z.object({
  school: optionalStringSchema,
  degree: optionalStringSchema,
  major: optionalStringSchema,
  period: optionalStringSchema,
  educationLevel: optionalStringSchema
});

const resumeExperienceSchema = z.object({
  company: optionalStringSchema,
  role: optionalStringSchema,
  period: optionalStringSchema,
  description: optionalStringSchema,
  highlights: stringArraySchema
});

const resumeProjectSchema = z.object({
  name: optionalStringSchema,
  role: optionalStringSchema,
  period: optionalStringSchema,
  description: optionalStringSchema,
  techStack: stringArraySchema,
  highlights: stringArraySchema
});

const resumeProfileSchema = z.object({
  email: optionalStringSchema,
  location: optionalStringSchema,
  birthDate: optionalStringSchema,
  workYears: optionalStringSchema,
  education: z.preprocess(nullToEmptyObjectArray, z.array(resumeEducationSchema).default([])),
  internships: z.preprocess(nullToEmptyObjectArray, z.array(resumeExperienceSchema).default([])),
  workExperiences: z.preprocess(nullToEmptyObjectArray, z.array(resumeExperienceSchema).default([])),
  projects: z.preprocess(nullToEmptyObjectArray, z.array(resumeProjectSchema).default([])),
  skills: stringArraySchema,
  certificates: stringArraySchema,
  languages: stringArraySchema,
  rawHighlights: stringArraySchema
});

const extractionSchema = z.object({
  candidateName: z.string().min(1),
  phone: optionalStringSchema,
  jobId: optionalStringSchema,
  position: z.string().min(1),
  stage: z.enum(stageValues as [RecruitmentStage, ...RecruitmentStage[]]),
  interviewTime: optionalStringSchema,
  owner: optionalStringSchema,
  sourceGroup: optionalStringSchema,
  summary: z.string().min(1),
  risks: stringArraySchema,
  nextAction: z.string().min(1),
  confidence: z.number().min(0).max(1),
  resumeProfile: z.preprocess(blankToUndefined, resumeProfileSchema.optional()),
  matchScore: optionalNumberSchema,
  evaluation: resumeEvaluationSchema.optional()
});

const taskTypes: TaskType[] = [
  "resume_parse_match",
  "interview_feedback",
  "candidate_query",
  "job_requirement",
  "job_progress_query",
  "jd_generate",
  "schedule_update",
  "followup_reminder",
  "unknown"
];

const classifiedTaskSchema = z.object({
  type: z.enum(taskTypes as [TaskType, ...TaskType[]]),
  confidence: z.number().min(0).max(1),
  reason: optionalStringSchema,
  jobTitle: optionalStringSchema,
  candidateName: optionalStringSchema
});

const parsedJobRequirementSchema = z.object({
  title: z.string().min(1),
  targetHeadcount: optionalNumberSchema,
  owner: optionalStringSchema,
  requirements: stringArraySchema,
  supplement: optionalStringSchema
});

export class OpenAiCompatibleExtractor implements RecruitmentAi {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
    }
  ) {}

  async extract(message: string, context?: { sender?: string; groupName?: string }): Promise<ExtractedRecruitmentInfo> {
    if (!this.options.apiKey || !this.options.baseUrl) {
      throw new Error("未配置 OPENAI_BASE_URL 或 OPENAI_API_KEY");
    }

    const response = await axios.post(
      `${this.options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        model: this.options.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              [
                "你是招聘运营助手。请从企业微信群消息、简历文本或PDF解析文本中抽取招聘跟进信息，只返回JSON，不要Markdown。",
                "必须抽取字段值本身，不能把字段标签当成字段值。例如看到“姓名：于文涛|电话：17068236666”，candidateName必须是“于文涛”，phone必须是“17068236666”，绝不能返回“姓名”或“电话”。",
                "遇到“标签：值”“标签: 值”“标签 值”“标签|标签”这类结构化简历文本时，优先取冒号、空格或分隔符后的真实值。",
                "candidateName不能是姓名、候选人、应聘者、待确认候选人以外的字段标签；只有完全找不到真实姓名时才写待确认候选人。",
                "如果输入是简历或PDF解析文本，必须尽量抽取完整简历画像：学校、学历、专业、实习、工作经历、项目经历、技能、证书等；没有的信息用空数组或省略可选字段。",
                "stage只能是new, screening, interview_scheduled, interviewing, offer, rejected, withdrawn, manual_review。confidence为0到1。"
              ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              message,
              sender: context?.sender,
              groupName: context?.groupName,
              extractionRules: [
                "如果文本来自简历PDF，常见格式是“姓名：真实姓名|电话：手机号|邮箱：邮箱地址”，请抽取冒号后的值。",
                "不要复制字段名或表头作为答案，例如姓名、电话、邮箱、岗位、现居、出生年月都不是候选人姓名。",
                "如果文件名或目标岗位里出现岗位名，position可以使用目标岗位；但candidateName必须来自简历正文中的真实姓名。",
                "owner只保留负责人姓名或称呼，不要把“继续、负责、跟进、推进、记录”等动作词并入负责人。例如“王工继续跟进”应返回owner=王工。",
                "简历画像字段要从正文抽取，不要编造；项目、实习、工作经历需要保留名称、角色、时间、技术栈和关键成果。",
                "summary和nextAction需要使用抽取后的真实候选人姓名。"
              ],
              examples: [
                {
                  input: "姓名：于文涛|电话：17068236666\n邮箱：3079971388@qq.com|现居：吉林长春",
                  output: {
                    candidateName: "于文涛",
                    phone: "17068236666"
                  }
                },
                {
                  input: "张三一面反馈通过，Java基础扎实，但微服务项目深度一般，安排二面，王工继续跟进",
                  output: {
                    candidateName: "张三",
                    position: "待确认岗位",
                    stage: "interviewing",
                    owner: "王工",
                    nextAction: "安排二面"
                  }
                },
                {
                  input: "张三 Java后端候选人，明天下午3点一面，简历不错，王工跟进，手机号13800138000",
                  output: {
                    candidateName: "张三",
                    phone: "13800138000",
                    position: "Java后端",
                    stage: "interview_scheduled",
                    owner: "王工"
                  }
                },
                {
                  input: "李四沟通后不合适，淘汰，赵工记录原因",
                  output: {
                    candidateName: "李四",
                    position: "待确认岗位",
                    stage: "rejected",
                    owner: "赵工"
                  }
                }
              ],
              outputShape: {
                candidateName: "候选人姓名，缺失则写待确认候选人",
                phone: "手机号，可缺失",
                position: "岗位，缺失则根据上下文推断为待确认岗位",
                stage: "招聘阶段枚举",
                interviewTime: "ISO时间或自然语言时间，可缺失",
                owner: "负责人，可缺失",
                sourceGroup: "来源群",
                summary: "一句话摘要",
                risks: ["风险点"],
                nextAction: "下一步待办",
                confidence: 0.86,
                resumeProfile: {
                  email: "邮箱，可缺失",
                  location: "现居地或所在地，可缺失",
                  birthDate: "出生年月，可缺失",
                  workYears: "工作年限或实习年限，例如2年、3个月，可缺失",
                  education: [
                    {
                      school: "学校名称",
                      degree: "学位，例如本科、硕士",
                      major: "专业",
                      period: "就读时间",
                      educationLevel: "学历层次"
                    }
                  ],
                  internships: [
                    {
                      company: "实习公司",
                      role: "实习岗位",
                      period: "实习时间",
                      description: "实习内容摘要",
                      highlights: ["实习成果或负责事项"]
                    }
                  ],
                  workExperiences: [
                    {
                      company: "工作公司",
                      role: "工作岗位",
                      period: "工作时间",
                      description: "工作内容摘要",
                      highlights: ["工作成果或负责事项"]
                    }
                  ],
                  projects: [
                    {
                      name: "项目名称",
                      role: "项目角色",
                      period: "项目时间",
                      description: "项目简介",
                      techStack: ["技术栈"],
                      highlights: ["项目成果或职责亮点"]
                    }
                  ],
                  skills: ["技能关键词"],
                  certificates: ["证书"],
                  languages: ["语言能力"],
                  rawHighlights: ["简历中值得保留的亮点原文"]
                }
              }
            })
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AI 没有返回可解析内容");
    }
    const parsed = JSON.parse(content);
    return extractionSchema.parse(parsed);
  }

  async classifyTask(input: {
    content: string;
    kind: RecruitmentMessageKind;
    fileName?: string;
    sender?: string;
    groupName?: string;
  }): Promise<ClassifiedTask> {
    const parsed = await this.chatJson(
      "你是招聘群助手的任务分类器。只返回JSON，不要Markdown。根据用户在企业微信群@机器人后的内容判断任务类型。",
      {
        content: input.content,
        kind: input.kind,
        fileName: input.fileName,
        sender: input.sender,
        groupName: input.groupName,
        allowedTypes: taskTypes,
        outputShape: {
          type: "任务类型枚举",
          confidence: 0.9,
          reason: "一句话原因",
          jobTitle: "如果涉及岗位则抽取岗位名",
          candidateName: "如果涉及候选人则抽取姓名"
        }
      }
    );
    return classifiedTaskSchema.parse(parsed);
  }

  async parseJobRequirement(content: string): Promise<ParsedJobRequirement> {
    const parsed = await this.chatJson(
      "你是招聘需求解析助手。请从群消息中抽取岗位需求，只返回JSON，不要Markdown。",
      {
        content,
        outputShape: {
          title: "岗位名称",
          targetHeadcount: "招聘人数，数字，可缺失",
          owner: "负责人，可缺失",
          requirements: ["岗位要求、职责、优先条件"],
          supplement: "保留原始补充信息"
        }
      }
    );
    return parsedJobRequirementSchema.parse(parsed);
  }

  async evaluateResume(input: {
    resumeText: string;
    candidate: ExtractedRecruitmentInfo;
    jobTitle: string;
    job?: JobRequirement;
  }): Promise<ResumeEvaluation> {
    const parsed = await this.chatJson(
      "你是资深招聘面试官。请根据候选人简历和目标岗位需求，评估岗位匹配度与能力表现。只返回JSON，不要Markdown。分数范围0到100。",
      {
        resumeText: input.resumeText,
        candidate: input.candidate,
        targetJobTitle: input.jobTitle,
        jobRequirement: input.job
          ? {
              title: input.job.title,
              targetHeadcount: input.job.targetHeadcount,
              owner: input.job.owner,
              requirements: input.job.requirements,
              supplements: input.job.supplements,
              jdDraft: input.job.jdDraft
            }
          : undefined,
        outputShape: {
          matchScore: 86,
          recommendation: "strong_match | match | weak_match | not_match",
          abilityAssessment: {
            technical: 85,
            project: 80,
            domain: 75,
            communication: 70,
            stability: 65
          },
          strengths: ["和岗位相关的优势"],
          weaknesses: ["能力短板或信息缺口"],
          risks: ["招聘风险"],
          interviewFocus: ["面试需要重点追问的问题"],
          summary: "一句话评价候选人与目标岗位的匹配情况"
        }
      }
    );
    return resumeEvaluationSchema.parse(parsed);
  }

  async generateJd(job: JobRequirement): Promise<string> {
    const parsed = await this.chatJson(
      "你是资深招聘专家。请根据岗位需求生成中文JD，返回JSON，字段为jdDraft。JD要包含岗位职责、任职要求、加分项、面试关注点。",
      {
        job,
        outputShape: {
          jdDraft: "Markdown格式JD"
        }
      }
    );
    if (!parsed.jdDraft || typeof parsed.jdDraft !== "string") {
      throw new Error("AI 未返回 JD 草稿");
    }
    return parsed.jdDraft;
  }

  async summarizeJobProgress(progress: JobProgress): Promise<string> {
    const parsed = await this.chatJson(
      "你是招聘运营分析助手。请根据结构化岗位进度生成一句适合发到企业微信群的简短总结，返回JSON，字段为summary。",
      {
        progress: {
          title: progress.title,
          targetHeadcount: progress.targetHeadcount,
          effectiveCandidates: progress.effectiveCandidates,
          offerCandidates: progress.offerCandidates,
          gap: progress.gap,
          keyCandidates: progress.keyCandidates.map((item) => ({
            name: item.candidate.name,
            stage: item.candidate.stage,
            owner: item.candidate.owner,
            score: item.priorityScore
          })),
          riskCandidates: progress.riskCandidates.map((item) => ({
            name: item.candidate.name,
            riskLevel: item.riskLevel,
            reasons: item.reasons
          }))
        },
        outputShape: {
          summary: "80字以内岗位进度总结"
        }
      }
    );
    if (!parsed.summary || typeof parsed.summary !== "string") {
      throw new Error("AI 未返回岗位进度总结");
    }
    return parsed.summary;
  }

  private async chatJson(system: string, payload: unknown): Promise<Record<string, unknown>> {
    if (!this.options.apiKey || !this.options.baseUrl) {
      throw new Error("未配置 OPENAI_BASE_URL 或 OPENAI_API_KEY");
    }
    const response = await axios.post(
      `${this.options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        model: this.options.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI 没有返回可解析内容");
    return JSON.parse(content);
  }
}

export class RuleBasedFallbackExtractor implements RecruitmentAi {
  async extract(message: string, context?: { sender?: string; groupName?: string }): Promise<ExtractedRecruitmentInfo> {
    message = this.stripPromptLines(message);
    const clean = message
      .replace(/@\S+\s?/g, "")
      .split(/\r?\n/)
      .filter((line) => !/^(以下内容|请抽取|目标岗位：|文件名：)/.test(line.trim()))
      .join("\n")
      .trim();
    const phone = clean.match(/1[3-9]\d{9}/)?.[0];
    const owner = clean.match(/([\u4e00-\u9fa5A-Za-z]{1,8})(?:负责|跟进)/)?.[1];
    const position =
      clean.match(/(?:岗位|面试|候选人|推荐|应聘|投递)[：: ]?([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,18})/)?.[1] ??
      clean.match(/([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,18})(?:候选人|求职者|简历)/)?.[1] ??
      clean.match(/([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,18})(?:岗|工程师|开发|产品|运营|测试)/)?.[0] ??
      "待确认岗位";
    const candidateName =
      clean.match(/(?:候选人|推荐|面试|约了|联系)[：: ]?([\u4e00-\u9fa5]{2,4})/)?.[1] ??
      clean.match(/^([\u4e00-\u9fa5]{2,4})/)?.[1] ??
      "待确认候选人";
    const stage = this.guessStage(clean);
    const interviewTime =
      clean.match(/((?:今天|明天|后天|周[一二三四五六日天]|下周|本周).{0,12}?(?:\d{1,2}[点:：]\d{0,2}|上午|下午|晚上))/)?.[1] ??
      clean.match(/(\d{1,2}月\d{1,2}日.{0,8})/)?.[1];

    return extractionSchema.parse({
      candidateName,
      phone,
      position,
      stage,
      interviewTime,
      owner,
      sourceGroup: context?.groupName,
      summary: `${candidateName} - ${position}：${clean.slice(0, 80)}`,
      risks: clean.includes("犹豫") || clean.includes("不确定") ? ["候选人意向不稳定"] : [],
      nextAction: owner ? `请${owner}跟进${candidateName}` : `确认${candidateName}的下一步跟进人`,
      confidence: candidateName === "待确认候选人" || position === "待确认岗位" ? 0.55 : 0.78
    });
  }

  async classifyTask(input: { content: string; kind: RecruitmentMessageKind; fileName?: string }): Promise<ClassifiedTask> {
    const text = input.content.replace(/@\S+\s?/g, "");
    let type: TaskType = "unknown";
    if (/T\d{8}[A-Z0-9]{4}/.test(text)) type = "unknown";
    else if (input.kind === "resume_pdf") type = "resume_parse_match";
    else if (/生成|写|草拟|整理/.test(text) && /JD|jd|职位描述|岗位描述/.test(text)) type = "jd_generate";
    else if (/进展|进度|招得|找到多少|多少人|总结/.test(text) && /(岗位|岗|后端|前端|产品|测试|运营|研发|Java|Go|Python)/i.test(text)) type = "job_progress_query";
    else if (/招\s*\d+\s*人|招聘需求|岗位需求|JD|jd|要求|职责|任职|补充/.test(text)) type = "job_requirement";
    else if (/查|查询|现在|到哪|进展/.test(text) && !/(岗位|岗|招聘|招得)/.test(text)) type = "candidate_query";
    else if (/反馈|评价|面评|面试官|通过|不通过|二面|三面/.test(text)) type = "interview_feedback";
    else if (/提醒|跟进|待办/.test(text)) type = "followup_reminder";
    else if (/面试|时间|日程|约|一面|二面|三面|终面/.test(text)) type = "schedule_update";
    else if (/简历|候选人|推荐|投递/.test(text)) type = "resume_parse_match";
    return {
      type,
      confidence: type === "unknown" ? 0.45 : 0.72,
      jobTitle: this.extractJobTitle(text),
      candidateName: this.extractCandidateName(text)
    };
  }

  async parseJobRequirement(content: string): Promise<ParsedJobRequirement> {
    const clean = content.replace(/@\S+\s?/g, "").trim();
    const targetHeadcount = Number(clean.match(/招\s*(\d+)\s*人/)?.[1] ?? "") || undefined;
    const owner = clean.match(/([\u4e00-\u9fa5A-Za-z]{1,8})(?:负责|跟进)/)?.[1];
    const title =
      clean.match(/([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,20})(?:岗位|岗|职位)?(?:招|招聘|需求|补充|JD|jd)/)?.[1] ??
      this.extractJobTitle(clean) ??
      "";
    const requirements = clean
      .split(/[，,；;\n]/)
      .map((item) => item.trim())
      .filter((item) => /要求|熟悉|经验|负责|优先|需要|职责|任职/.test(item));
    return { title, targetHeadcount, owner, requirements, supplement: clean };
  }

  async evaluateResume(input: {
    resumeText: string;
    candidate: ExtractedRecruitmentInfo;
    jobTitle: string;
    job?: JobRequirement;
  }): Promise<ResumeEvaluation> {
    const text = `${input.resumeText}\n${input.job?.requirements.join("\n") ?? ""}\n${input.job?.supplements.join("\n") ?? ""}`;
    let matchScore = Math.round(input.candidate.confidence * 100);
    if (input.job) matchScore += 8;
    if (new RegExp(input.jobTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) matchScore += 7;
    if (input.candidate.risks.length) matchScore -= 10;
    matchScore = Math.max(35, Math.min(92, matchScore));
    const recommendation =
      matchScore >= 85 ? "strong_match" : matchScore >= 70 ? "match" : matchScore >= 55 ? "weak_match" : "not_match";

    return resumeEvaluationSchema.parse({
      matchScore,
      recommendation,
      abilityAssessment: {
        technical: matchScore,
        project: Math.max(matchScore - 5, 0),
        domain: input.job ? Math.max(matchScore - 8, 0) : Math.max(matchScore - 15, 0),
        communication: input.candidate.owner ? 72 : 65,
        stability: input.candidate.risks.length ? 55 : 72
      },
      strengths: input.job ? [`简历已按${input.jobTitle}岗位要求评估`] : [`已指定目标岗位${input.jobTitle}`],
      weaknesses: input.job ? [] : ["系统尚未录入该岗位的详细需求，匹配评估偏保守"],
      risks: input.candidate.risks,
      interviewFocus: ["核实项目经历与目标岗位核心要求的匹配度", "确认候选人的稳定性和求职意向"],
      summary: `${input.candidate.candidateName}与${input.jobTitle}岗位匹配度${matchScore}分，建议${this.recommendationText(recommendation)}。`
    });
  }

  async generateJd(job: JobRequirement): Promise<string> {
    const requirements = [...job.requirements, ...job.supplements].filter(Boolean);
    return [
      `# ${job.title} JD`,
      "",
      `招聘人数：${job.targetHeadcount ?? "待确认"}人`,
      `负责人：${job.owner ?? "待确认"}`,
      "",
      "## 岗位职责",
      requirements.length ? requirements.map((item) => `- ${item}`).join("\n") : "- 根据业务需求完成岗位相关工作。",
      "",
      "## 任职要求",
      "- 具备相关岗位经验，能独立推进工作。",
      "- 沟通协作能力良好，有结果导向。",
      "",
      "## 加分项",
      "- 有相近行业或复杂项目经验。"
    ].join("\n");
  }

  async summarizeJobProgress(progress: JobProgress): Promise<string> {
    const targetText = progress.targetHeadcount === undefined ? "尚未录入目标人数" : `目标${progress.targetHeadcount}人`;
    const gapText = progress.gap === undefined ? "" : `，缺口${progress.gap}人`;
    return `${progress.title}：${targetText}，有效候选${progress.effectiveCandidates}人，Offer ${progress.offerCandidates}人，风险候选${progress.riskCandidates.length}人${gapText}。`;
  }

  private guessStage(message: string): RecruitmentStage {
    if (/offer|录用|发薪|谈薪/i.test(message)) return "offer";
    if (/淘汰|不合适|拒绝/i.test(message)) return "rejected";
    if (/放弃|不考虑|拒了/i.test(message)) return "withdrawn";
    if (/二面|三面|复试|面试中/i.test(message)) return "interviewing";
    if (/一面|约面|面试|明天|今天|后天|日程/i.test(message)) return "interview_scheduled";
    if (/简历|筛选|初筛/i.test(message)) return "screening";
    return "new";
  }

  private stripPromptLines(message: string): string {
    return message
      .split(/\r?\n/)
      .filter((line) => {
        const clean = line.trim();
        return !/^(以下内容|数据库查询工具使用规则|数据库查询结果|相似候选人：|可用岗位：|如果消息|姓名抽取少样本|普通群消息抽取少样本|输入：|输出：|1\.|2\.|3\.|4\.)/.test(
          clean
        );
      })
      .join("\n");
  }

  private extractJobTitle(content: string): string | undefined {
    return (
      content.match(/([\u4e00-\u9fa5A-Za-z0-9+#.\-]{2,20})(?:岗位|岗|职位)/)?.[1] ??
      content.match(/(Java后端|Go后端|Python后端|前端|产品经理|测试工程师|运营|研发)/i)?.[1]
    );
  }

  private extractCandidateName(content: string): string | undefined {
    const clean = content.replace(/查一下|查询|进展|现在|到哪一步|候选人/g, "").trim();
    return clean.match(/([\u4e00-\u9fa5]{2,4})/)?.[1];
  }

  private recommendationText(recommendation: ResumeEvaluation["recommendation"]): string {
    if (recommendation === "strong_match") return "优先推进";
    if (recommendation === "match") return "继续推进";
    if (recommendation === "weak_match") return "谨慎推进";
    return "暂不推荐";
  }
}

export class ResilientAiExtractor implements RecruitmentAi {
  constructor(
    private readonly primary: RecruitmentAi,
    private readonly fallback: RecruitmentAi
  ) {}

  async extract(message: string, context?: { sender?: string; groupName?: string }): Promise<ExtractedRecruitmentInfo> {
    try {
      return await this.primary.extract(message, context);
    } catch {
      return this.fallback.extract(message, context);
    }
  }

  async classifyTask(input: {
    content: string;
    kind: RecruitmentMessageKind;
    fileName?: string;
    sender?: string;
    groupName?: string;
  }): Promise<ClassifiedTask> {
    try {
      const result = await this.primary.classifyTask(input);
      return result.confidence >= 0.6 ? result : this.fallback.classifyTask(input);
    } catch {
      return this.fallback.classifyTask(input);
    }
  }

  async parseJobRequirement(content: string): Promise<ParsedJobRequirement> {
    try {
      return await this.primary.parseJobRequirement(content);
    } catch {
      return this.fallback.parseJobRequirement(content);
    }
  }

  async evaluateResume(input: {
    resumeText: string;
    candidate: ExtractedRecruitmentInfo;
    jobTitle: string;
    job?: JobRequirement;
  }): Promise<ResumeEvaluation> {
    try {
      return await this.primary.evaluateResume(input);
    } catch {
      return this.fallback.evaluateResume(input);
    }
  }

  async generateJd(job: JobRequirement): Promise<string> {
    try {
      return await this.primary.generateJd(job);
    } catch {
      return this.fallback.generateJd(job);
    }
  }

  async summarizeJobProgress(progress: JobProgress): Promise<string> {
    try {
      return await this.primary.summarizeJobProgress(progress);
    } catch {
      return this.fallback.summarizeJobProgress(progress);
    }
  }
}

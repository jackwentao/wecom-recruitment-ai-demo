import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleExtractor, RuleBasedFallbackExtractor } from "./AiExtractor";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RuleBasedFallbackExtractor", () => {
  it("可以从招聘话术中抽取候选人、岗位和负责人", async () => {
    const extractor = new RuleBasedFallbackExtractor();
    const result = await extractor.extract(
      "@招聘助手 张三 Java后端候选人，明天下午3点一面，简历不错，王工跟进，手机号13800138000",
      { groupName: "招聘内部协作群" }
    );

    expect(result.candidateName).toBe("张三");
    expect(result.phone).toBe("13800138000");
    expect(result.position).toContain("Java");
    expect(result.stage).toBe("interview_scheduled");
    expect(result.owner).toBe("王工");
    expect(result.sourceGroup).toBe("招聘内部协作群");
  });
});

describe("OpenAiCompatibleExtractor", () => {
  it("简历抽取提示词明确要求从标签值格式中取真实姓名", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidateName: "于文涛",
                phone: "17068236666",
                position: "Java后端",
                stage: "screening",
                summary: "于文涛投递Java后端岗位",
                risks: [],
                nextAction: "进行简历筛选和岗位匹配评估",
                confidence: 0.9,
                resumeProfile: {
                  email: "3079971388@qq.com",
                  location: "吉林长春",
                  birthDate: "2002.05",
                  workYears: "",
                  education: [{ school: "吉林大学", degree: "本科", major: "软件工程", period: "2020-2024", educationLevel: "本科" }],
                  internships: [{ company: "某科技公司", role: "Java开发实习生", period: "2023.06-2023.09", description: "参与后端接口开发", highlights: ["完成接口开发"] }],
                  workExperiences: [],
                  projects: [{ name: "招聘系统", role: "后端开发", period: "2023", description: "负责候选人模块", techStack: ["Java", "Spring Boot"], highlights: ["实现简历解析"] }],
                  skills: ["Java", "Spring Boot", "MySQL"],
                  certificates: [],
                  languages: [],
                  rawHighlights: ["有Java项目经验"]
                }
              })
            }
          }
        ]
      }
    });

    const extractor = new OpenAiCompatibleExtractor({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      model: "deepseek-v4-flash"
    });

    const result = await extractor.extract(
      "目标岗位：Java后端\nPDF文本：\n姓名：于文涛|电话：17068236666\n邮箱：3079971388@qq.com|现居：吉林长春"
    );

    expect(result.candidateName).toBe("于文涛");
    expect(result.resumeProfile?.education[0]?.school).toBe("吉林大学");
    expect(result.resumeProfile?.internships[0]?.role).toBe("Java开发实习生");
    expect(result.resumeProfile?.projects[0]?.techStack).toContain("Spring Boot");

    const request = post.mock.calls[0]?.[1] as { messages?: Array<{ role: string; content: string }> };
    const systemPrompt = request.messages?.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = request.messages?.find((message) => message.role === "user")?.content ?? "";

    expect(systemPrompt).toContain("不能把字段标签当成字段值");
    expect(systemPrompt).toContain("candidateName必须是“于文涛”");
    expect(systemPrompt).toContain("学校、学历、专业、实习、工作经历、项目经历、技能、证书");
    expect(userPrompt).toContain("姓名：于文涛|电话：17068236666");
    expect(userPrompt).toContain("不要复制字段名或表头作为答案");
    expect(userPrompt).toContain("resumeProfile");
    expect(userPrompt).toContain("项目名称");
  });

  it("任务分类可以兼容LLM返回null可选字段", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "job_requirement",
                confidence: 0.92,
                reason: null,
                jobTitle: "Java后端",
                candidateName: ""
              })
            }
          }
        ]
      }
    });

    const extractor = new OpenAiCompatibleExtractor({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      model: "deepseek-v4-flash"
    });

    const result = await extractor.classifyTask({
      content: "@招聘助手 Java后端岗位招3人，王工负责",
      kind: "text"
    });

    expect(result.type).toBe("job_requirement");
    expect(result.jobTitle).toBe("Java后端");
    expect(result.candidateName).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("可以解析简历匹配和能力评估结果", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                matchScore: 88,
                recommendation: "strong_match",
                abilityAssessment: {
                  technical: 90,
                  project: 86,
                  domain: 82,
                  communication: 76,
                  stability: 72
                },
                strengths: ["Java后端经验扎实"],
                weaknesses: [""],
                risks: null,
                interviewFocus: ["追问微服务治理经验"],
                summary: "候选人与Java后端岗位高度匹配"
              })
            }
          }
        ]
      }
    });

    const extractor = new OpenAiCompatibleExtractor({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      model: "deepseek-v4-flash"
    });

    const result = await extractor.evaluateResume({
      resumeText: "5年Java后端经验，熟悉Spring Boot和微服务",
      jobTitle: "Java后端",
      candidate: {
        candidateName: "张三",
        position: "Java后端",
        stage: "screening",
        summary: "Java后端候选人",
        risks: [],
        nextAction: "安排面试",
        confidence: 0.9
      }
    });

    expect(result.matchScore).toBe(88);
    expect(result.recommendation).toBe("strong_match");
    expect(result.risks).toEqual([]);
  });
});

import { MysqlAppDataStore } from "../src/server/repositories/MysqlAppDataStore";
import { CandidateRepository } from "../src/server/repositories/CandidateRepository";
import { RecruitmentMessageService } from "../src/server/services/RecruitmentMessageService";
import { RuleBasedFallbackExtractor } from "../src/server/ai/AiExtractor";
import { config } from "../src/server/config";

async function main() {
  const store = new MysqlAppDataStore(config.mysql);
  const repository = new CandidateRepository(store);
  const service = new RecruitmentMessageService(repository, new RuleBasedFallbackExtractor());

  await repository.clear();
  const job = await repository.upsertJobRequirement({
    title: "Java后端",
    targetHeadcount: 3,
    owner: "王工",
    supplement: "MySQL smoke test"
  });
  const first = await service.process({
    source: "local_simulator",
    content: "@招聘助手 张三 Java后端候选人，明天下午3点一面，王工跟进，手机号13800138000",
    sender: "MySQL测试",
    groupName: "招聘内部协作群"
  });
  const updated = await service.process({
    source: "local_simulator",
    content: "@招聘助手 张三一面反馈通过，Java基础扎实，安排二面，王工继续跟进",
    sender: "MySQL测试",
    groupName: "招聘内部协作群"
  });
  const candidates = await repository.listCandidates({});

  await store.close();

  if (candidates.length !== 1) throw new Error(`候选人应为1个，实际${candidates.length}`);
  if (first.candidate?.id !== updated.candidate?.id) throw new Error("张三更新没有命中原候选人");
  if (updated.candidate?.name !== "张三") throw new Error(`候选人姓名应归一为张三，实际${updated.candidate?.name}`);
  if (updated.candidate?.jobId !== job.id) throw new Error("候选人没有绑定原Java后端岗位");

  console.log("MySQL 招聘链路 smoke test 通过。");
  console.log(
    JSON.stringify(
      {
        jobId: job.id,
        candidateId: updated.candidate?.id,
        candidateCount: candidates.length,
        name: updated.candidate?.name,
        position: updated.candidate?.position,
        stage: updated.candidate?.stage,
        timelineCount: updated.candidate?.timeline.length
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("MySQL 招聘链路 smoke test 失败：");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});


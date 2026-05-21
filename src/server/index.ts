import express from "express";
import cors from "cors";
import { config } from "./config";
import { OpenAiCompatibleExtractor, ResilientAiExtractor, RuleBasedFallbackExtractor } from "./ai/AiExtractor";
import { createRecruitmentRepository } from "./repositories/createRepository";
import { RecruitmentMessageService } from "./services/RecruitmentMessageService";
import { WeComCrypto } from "./wecom/WeComCrypto";
import { WeComBotAdapter } from "./wecom/WeComBotAdapter";
import { PdfTextExtractor } from "./documents/PdfTextExtractor";
import { WeComMediaClient } from "./wecom/WeComMediaClient";
import { createRouter } from "./routes";

export function createApp() {
  const app = express();
  app.use(cors({ origin: config.appBaseUrl, credentials: true }));

  const repository = createRecruitmentRepository(config);
  const extractor = new ResilientAiExtractor(
    new OpenAiCompatibleExtractor(config.ai),
    new RuleBasedFallbackExtractor()
  );
  const service = new RecruitmentMessageService(repository, extractor, config.appBaseUrl);
  const documentExtractor = new PdfTextExtractor();
  const wecomAdapter = new WeComBotAdapter(
    new WeComCrypto(config.wecom.token, config.wecom.encodingAesKey, config.wecom.receiveId),
    service,
    {
      replyEnabled: config.wecom.replyEnabled,
      mediaClient: new WeComMediaClient({
        corpId: config.wecom.corpId,
        appSecret: config.wecom.appSecret
      }),
      documentExtractor
    }
  );

  app.use("/api", createRouter({ repository, service, wecomAdapter, documentExtractor }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: error instanceof Error ? error.message : "服务器内部错误" });
  });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  createApp().listen(config.port, () => {
    console.log(`招聘 AI Demo 后端已启动：http://localhost:${config.port}`);
  });
}

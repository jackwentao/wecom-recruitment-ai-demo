import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { config } from "../src/server/config";
import { RuleBasedFallbackExtractor } from "../src/server/ai/AiExtractor";
import { PlainTextDocumentExtractor } from "../src/server/documents/PdfTextExtractor";
import { CandidateRepository } from "../src/server/repositories/CandidateRepository";
import { createRouter } from "../src/server/routes";
import { RecruitmentMessageService } from "../src/server/services/RecruitmentMessageService";
import { WeComBotAdapter } from "../src/server/wecom/WeComBotAdapter";
import { WeComCrypto } from "../src/server/wecom/WeComCrypto";

function assertWeComConfig() {
  if (!config.wecom.token || config.wecom.token === "dev-token") {
    throw new Error("请先配置 WECOM_BOT_TOKEN。");
  }
  if (!config.wecom.encodingAesKey) {
    throw new Error("请先配置 WECOM_BOT_ENCODING_AES_KEY。");
  }
}

function buildEncryptedXml(crypto: WeComCrypto, plainXml: string, timestamp: string, nonce: string) {
  const encrypt = crypto.encrypt(plainXml);
  const msgSignature = crypto.sign(timestamp, nonce, encrypt);
  const xml = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  return { encrypt, msgSignature, xml };
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? { message: error.message } : { message: String(error) };
}

async function closeServer(server: http.Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main() {
  assertWeComConfig();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-callback-smoke-"));
  let server: http.Server | undefined;

  try {
    const repository = new CandidateRepository(path.join(tempDir, "data.json"));
    const ai = new RuleBasedFallbackExtractor();
    const service = new RecruitmentMessageService(repository, ai);
    const crypto = new WeComCrypto(config.wecom.token, config.wecom.encodingAesKey, config.wecom.receiveId);
    const app = express();
    app.use(
      "/api",
      createRouter({
        repository,
        service,
        wecomAdapter: new WeComBotAdapter(crypto, service, {
          replyEnabled: true,
          documentExtractor: new PlainTextDocumentExtractor()
        }),
        documentExtractor: new PlainTextDocumentExtractor()
      })
    );

    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("本地测试服务启动失败。");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const callbackUrl = `${baseUrl}/api/wecom/aibot/callback`;

    console.log(`WeCom callback smoke test: ${callbackUrl}`);
    console.log(`Token=已配置, EncodingAESKey=已配置, ReceiveId=${config.wecom.receiveId || "(空)"}`);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = "smoke-nonce";

    const echostr = crypto.encrypt("wecom-url-verify-ok");
    const verifySignature = crypto.sign(timestamp, nonce, echostr);
    const verifyUrl = `${callbackUrl}?msg_signature=${verifySignature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`;
    const verifyResponse = await fetch(verifyUrl);
    const verifyText = await verifyResponse.text();
    if (!verifyResponse.ok || verifyText !== "wecom-url-verify-ok") {
      throw new Error(`URL校验失败：status=${verifyResponse.status}, body=${verifyText}`);
    }
    console.log("[PASS] GET URL校验：验签和echostr解密成功");

    const plainMessageXml = [
      "<xml>",
      "<MsgType><![CDATA[text]]></MsgType>",
      "<Content><![CDATA[@招聘助手 张三 Java后端候选人，明天下午一面，王工跟进，手机号13800138000]]></Content>",
      "<FromUserName><![CDATA[smoke-user]]></FromUserName>",
      "<ChatId><![CDATA[smoke-group]]></ChatId>",
      "<MsgId>smoke-msg-1</MsgId>",
      "</xml>"
    ].join("");
    const encrypted = buildEncryptedXml(crypto, plainMessageXml, timestamp, nonce);
    const messageUrl = `${callbackUrl}?msg_signature=${encrypted.msgSignature}&timestamp=${timestamp}&nonce=${nonce}`;
    const messageResponse = await fetch(messageUrl, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: encrypted.xml
    });
    const messageBody = await messageResponse.text();
    if (!messageResponse.ok) {
      throw new Error(`消息回调失败：status=${messageResponse.status}, body=${messageBody}`);
    }
    const replyEncrypt = messageBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/)?.[1];
    if (!replyEncrypt) {
      throw new Error(`未收到加密回复XML：${messageBody}`);
    }
    const replyPlainXml = crypto.decrypt(replyEncrypt);
    if (!replyPlainXml.includes("MsgType") || !replyPlainXml.includes("Content")) {
      throw new Error(`回复XML解密后格式异常：${replyPlainXml}`);
    }
    console.log("[PASS] POST文本消息：验签、解密、业务处理、加密回复成功");

    const candidates = await repository.listCandidates({});
    if (candidates.length !== 1 || candidates[0].name !== "张三") {
      throw new Error(`候选人入库验证失败：${JSON.stringify(candidates, null, 2)}`);
    }
    console.log("[PASS] 候选人入库：张三已写入本地仓储");
    console.log("\nWeCom callback smoke test passed: 3/3 passed.");
  } finally {
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(JSON.stringify(sanitizeError(error), null, 2));
  process.exit(1);
});

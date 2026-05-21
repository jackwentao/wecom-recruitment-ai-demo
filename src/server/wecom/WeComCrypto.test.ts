import { describe, expect, it } from "vitest";
import { parsePlainWeComMessage, WeComCrypto } from "./WeComCrypto";

const token = "test-token";
const aesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

describe("WeComCrypto", () => {
  it("可以生成并校验企业微信签名", () => {
    const crypto = new WeComCrypto(token, aesKey);
    const signature = crypto.sign("123456", "nonce", "encrypted-text");
    expect(
      crypto.verifySignature({
        timestamp: "123456",
        nonce: "nonce",
        encrypt: "encrypted-text",
        msgSignature: signature
      })
    ).toBe(true);
    expect(
      crypto.verifySignature({
        timestamp: "123456",
        nonce: "nonce",
        encrypt: "tampered",
        msgSignature: signature
      })
    ).toBe(false);
  });

  it("可以加密并解密 XML 消息", () => {
    const crypto = new WeComCrypto(token, aesKey, "demo");
    const xml = "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[张三 Java 一面]]></Content></xml>";
    const encrypted = crypto.encrypt(xml);
    expect(crypto.decrypt(encrypted)).toBe(xml);
  });
});

describe("parsePlainWeComMessage", () => {
  it("可以解析文本消息字段", async () => {
    const parsed = await parsePlainWeComMessage(
      "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[张三 Java 一面]]></Content><FromUserName><![CDATA[wang]]></FromUserName><ChatId><![CDATA[group-1]]></ChatId><MsgId>42</MsgId></xml>"
    );
    expect(parsed.content).toBe("张三 Java 一面");
    expect(parsed.fromUser).toBe("wang");
    expect(parsed.groupName).toBe("group-1");
    expect(parsed.msgId).toBe("42");
  });

  it("可以解析企业微信文件消息字段", async () => {
    const parsed = await parsePlainWeComMessage(
      "<xml><MsgType><![CDATA[file]]></MsgType><MediaId><![CDATA[media-1]]></MediaId><FileName><![CDATA[张三简历.pdf]]></FileName><FileSize>2048</FileSize></xml>"
    );
    expect(parsed.content).toBe("张三简历.pdf");
    expect(parsed.mediaId).toBe("media-1");
    expect(parsed.fileName).toBe("张三简历.pdf");
    expect(parsed.fileSize).toBe(2048);
  });
});

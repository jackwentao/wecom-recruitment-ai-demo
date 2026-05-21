import type { Request, Response } from "express";
import type { RecruitmentMessageService } from "../services/RecruitmentMessageService";
import {
  buildTextReplyXml,
  parseEncryptedXml,
  parsePlainWeComMessage,
  WeComCrypto
} from "./WeComCrypto";
import type { DocumentTextExtractor } from "../documents/PdfTextExtractor";
import type { WeComMediaClient } from "./WeComMediaClient";
import type { MessageAttachment, RecruitmentMessageKind } from "../../shared/types";

export class WeComBotAdapter {
  constructor(
    private readonly crypto: WeComCrypto,
    private readonly service: RecruitmentMessageService,
    private readonly options: {
      replyEnabled: boolean;
      mediaClient?: WeComMediaClient;
      documentExtractor?: DocumentTextExtractor;
    }
  ) {}

  async verifyUrl(req: Request, res: Response): Promise<void> {
    const msgSignature = String(req.query.msg_signature ?? "");
    const timestamp = String(req.query.timestamp ?? "");
    const nonce = String(req.query.nonce ?? "");
    const echostr = String(req.query.echostr ?? "");

    if (!msgSignature || !timestamp || !nonce || !echostr) {
      res.status(400).send("missing wecom verification params");
      return;
    }
    if (!this.crypto.verifySignature({ msgSignature, timestamp, nonce, encrypt: echostr })) {
      res.status(403).send("invalid signature");
      return;
    }
    res.type("text/plain").send(this.crypto.decrypt(echostr));
  }

  async receive(req: Request, res: Response): Promise<void> {
    try {
      const msgSignature = String(req.query.msg_signature ?? "");
      const timestamp = String(req.query.timestamp ?? Math.floor(Date.now() / 1000));
      const nonce = String(req.query.nonce ?? "");
      const xmlBody = typeof req.body === "string" ? req.body : "";
      const { encrypt } = await parseEncryptedXml(xmlBody);

      if (!this.crypto.verifySignature({ msgSignature, timestamp, nonce, encrypt })) {
        res.status(403).send("invalid signature");
        return;
      }

      const plainXml = this.crypto.decrypt(encrypt);
      const parsed = await parsePlainWeComMessage(plainXml);
      if (!parsed.content) {
        res.status(200).send("success");
        return;
      }

      const attachment = await this.resolveAttachment(parsed);
      const kind = this.resolveKind(parsed.msgType, parsed.content, attachment);
      const content = attachment?.extractedText ?? parsed.content;

      const result = await this.service.process({
        source: "wecom_aibot",
        kind,
        content,
        sender: parsed.fromUser,
        groupName: parsed.groupName,
        messageId: parsed.msgId,
        attachment
      });

      if (!this.options.replyEnabled) {
        res.status(200).send("success");
        return;
      }
      const replyXml = buildTextReplyXml(result.replyText);
      res.type("application/xml").send(this.crypto.wrapEncryptedXml(replyXml, String(timestamp), nonce || "reply"));
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "wecom callback failed");
    }
  }

  private async resolveAttachment(parsed: {
    mediaId?: string;
    fileName?: string;
    fileSize?: number;
  }): Promise<MessageAttachment | undefined> {
    if (!parsed.mediaId && !parsed.fileName) {
      return undefined;
    }
    const attachment: MessageAttachment = {
      mediaId: parsed.mediaId,
      fileName: parsed.fileName,
      size: parsed.fileSize,
      mimeType: parsed.fileName?.toLowerCase().endsWith(".pdf") ? "application/pdf" : undefined
    };
    if (parsed.mediaId && parsed.fileName?.toLowerCase().endsWith(".pdf")) {
      try {
        const buffer = await this.options.mediaClient?.download(parsed.mediaId);
        if (buffer && this.options.documentExtractor) {
          attachment.extractedText = await this.options.documentExtractor.extractPdf(buffer);
        } else {
          attachment.extractionError = "未配置企业微信文件下载凭证或PDF抽取器";
        }
      } catch (error) {
        attachment.extractionError = error instanceof Error ? error.message : "PDF附件处理失败";
      }
    }
    return attachment;
  }

  private resolveKind(msgType?: string, content?: string, attachment?: MessageAttachment): RecruitmentMessageKind {
    if (attachment?.fileName?.toLowerCase().endsWith(".pdf")) return "resume_pdf";
    if (msgType === "file") return "file";
    if (content && /反馈|评价|面评|面试官|通过|不通过|二面|三面/.test(content)) return "interview_feedback";
    return "text";
  }
}

import crypto from "node:crypto";
import { parseStringPromise, Builder } from "xml2js";

export interface WeComEncryptedPayload {
  encrypt: string;
  msgSignature: string;
  timestamp: string;
  nonce: string;
}

export class WeComCrypto {
  private readonly aesKey?: Buffer;

  constructor(
    private readonly token: string,
    encodingAesKey?: string,
    private readonly receiveId = ""
  ) {
    if (encodingAesKey) {
      const normalizedKey = encodingAesKey.length === 43 ? `${encodingAesKey}=` : encodingAesKey;
      this.aesKey = Buffer.from(normalizedKey, "base64");
      if (this.aesKey.length !== 32) {
        throw new Error("EncodingAESKey 解码后必须为32字节");
      }
    }
  }

  sign(timestamp: string, nonce: string, encrypt: string): string {
    return crypto.createHash("sha1").update([this.token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
  }

  verifySignature(payload: WeComEncryptedPayload): boolean {
    return this.sign(payload.timestamp, payload.nonce, payload.encrypt) === payload.msgSignature;
  }

  decrypt(encrypt: string): string {
    if (!this.aesKey) {
      throw new Error("未配置 WECOM_BOT_ENCODING_AES_KEY，无法解密企业微信回调");
    }
    const encrypted = Buffer.from(encrypt, "base64");
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const unpadded = this.pkcs7Unpad(decrypted);
    const messageLength = unpadded.readUInt32BE(16);
    return unpadded.subarray(20, 20 + messageLength).toString("utf-8");
  }

  encrypt(plainText: string): string {
    if (!this.aesKey) {
      throw new Error("未配置 WECOM_BOT_ENCODING_AES_KEY，无法加密企业微信回复");
    }
    const random = crypto.randomBytes(16);
    const message = Buffer.from(plainText, "utf-8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.length, 0);
    const appId = Buffer.from(this.receiveId, "utf-8");
    const padded = this.pkcs7Pad(Buffer.concat([random, length, message, appId]));
    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, this.aesKey.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  }

  wrapEncryptedXml(plainXml: string, timestamp = Math.floor(Date.now() / 1000).toString(), nonce = crypto.randomBytes(8).toString("hex")): string {
    const encrypt = this.encrypt(plainXml);
    const msgSignature = this.sign(timestamp, nonce, encrypt);
    return new Builder({ headless: true, rootName: "xml", cdata: true }).buildObject({
      Encrypt: encrypt,
      MsgSignature: msgSignature,
      TimeStamp: timestamp,
      Nonce: nonce
    });
  }

  private pkcs7Pad(buffer: Buffer): Buffer {
    const blockSize = 32;
    let pad = blockSize - (buffer.length % blockSize);
    if (pad === 0) pad = blockSize;
    return Buffer.concat([buffer, Buffer.alloc(pad, pad)]);
  }

  private pkcs7Unpad(buffer: Buffer): Buffer {
    const pad = buffer[buffer.length - 1];
    if (pad < 1 || pad > 32) {
      return buffer;
    }
    return buffer.subarray(0, buffer.length - pad);
  }
}

export async function parseEncryptedXml(xml: string): Promise<{ encrypt: string }> {
  const result = await parseStringPromise(xml, { explicitArray: false, trim: true });
  return {
    encrypt: result.xml?.Encrypt ?? result.Encrypt
  };
}

export async function parsePlainWeComMessage(xml: string): Promise<{
  msgType?: string;
  content?: string;
  fromUser?: string;
  groupName?: string;
  msgId?: string;
  mediaId?: string;
  fileName?: string;
  fileSize?: number;
}> {
  const result = await parseStringPromise(xml, { explicitArray: false, trim: true });
  const root = result.xml ?? result;
  return {
    msgType: root.MsgType,
    content: root.Content ?? root.Text?.Content ?? root.FileName ?? root.Title,
    fromUser: root.FromUserName ?? root.From?.UserId,
    groupName: root.ChatId ?? root.RoomId ?? root.GroupName,
    msgId: root.MsgId ?? root.MsgID,
    mediaId: root.MediaId ?? root.MediaID,
    fileName: root.FileName ?? root.Title,
    fileSize: root.FileSize ? Number(root.FileSize) : undefined
  };
}

export function buildTextReplyXml(content: string): string {
  return new Builder({ headless: true, rootName: "xml", cdata: true }).buildObject({
    MsgType: "text",
    Content: content
  });
}

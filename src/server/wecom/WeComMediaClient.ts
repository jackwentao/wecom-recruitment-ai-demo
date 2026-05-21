import axios from "axios";

export interface WeComMediaClientOptions {
  corpId?: string;
  appSecret?: string;
}

export class WeComMediaClient {
  private tokenCache?: { token: string; expiresAt: number };

  constructor(private readonly options: WeComMediaClientOptions) {}

  async download(mediaId: string): Promise<Buffer | undefined> {
    if (!this.options.corpId || !this.options.appSecret) {
      return undefined;
    }
    const token = await this.getAccessToken();
    const response = await axios.get("https://qyapi.weixin.qq.com/cgi-bin/media/get", {
      params: {
        access_token: token,
        media_id: mediaId
      },
      responseType: "arraybuffer",
      timeout: 15000
    });
    return Buffer.from(response.data);
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
      return this.tokenCache.token;
    }
    const response = await axios.get("https://qyapi.weixin.qq.com/cgi-bin/gettoken", {
      params: {
        corpid: this.options.corpId,
        corpsecret: this.options.appSecret
      },
      timeout: 10000
    });
    if (!response.data?.access_token) {
      throw new Error(`获取企业微信 access_token 失败：${response.data?.errmsg ?? "未知错误"}`);
    }
    this.tokenCache = {
      token: response.data.access_token,
      expiresAt: Date.now() + Number(response.data.expires_in ?? 7200) * 1000
    };
    return this.tokenCache.token;
  }
}

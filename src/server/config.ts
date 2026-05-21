import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 3001),
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:5173",
  dataStore: (process.env.DATA_STORE ?? "json") as "json" | "mysql",
  dataFile: process.env.DATA_FILE ?? "data/app-data.json",
  mysql: {
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: process.env.MYSQL_DATABASE ?? "recruitment_ai",
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10)
  },
  wecom: {
    token: process.env.WECOM_BOT_TOKEN ?? "dev-token",
    encodingAesKey: process.env.WECOM_BOT_ENCODING_AES_KEY ?? "",
    receiveId: process.env.WECOM_BOT_RECEIVE_ID ?? "",
    replyEnabled: process.env.WECOM_REPLY_ENABLED !== "false",
    corpId: process.env.WECOM_CORP_ID ?? "",
    appSecret: process.env.WECOM_APP_SECRET ?? ""
  },
  ai: {
    baseUrl: process.env.OPENAI_BASE_URL ?? "",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.AI_MODEL ?? "deepseek-v4-flash"
  }
};

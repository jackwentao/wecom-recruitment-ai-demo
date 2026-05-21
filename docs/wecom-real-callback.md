# 企业微信真实回调联调说明

## 项目侧已具备的能力

- `GET /api/wecom/aibot/callback`：企业微信 URL 校验，支持 `msg_signature`、`timestamp`、`nonce`、`echostr` 验签和解密。
- `POST /api/wecom/aibot/callback`：企业微信加密消息回调，支持文本消息和文件消息。
- 文本消息会进入招聘消息处理链路，完成任务分类、候选人入库、岗位处理等。
- PDF 文件消息会尝试用 `MediaId` 下载文件、抽取 PDF 文本；缺目标岗位时会创建待确认任务，用户回复任务 ID + 岗位后会自动继续解析、评估、入库。
- `npm run smoke:wecom-callback`：用当前 `.env` 的企业微信配置生成同款加密请求，验证本地回调栈。

## 需要准备的企业微信参数

先跑通文本回调至少需要：

```env
WECOM_BOT_TOKEN=企业微信后台配置的Token
WECOM_BOT_ENCODING_AES_KEY=企业微信后台配置的EncodingAESKey
WECOM_BOT_RECEIVE_ID=企业微信后台要求的ReceiveId或机器人ID
WECOM_REPLY_ENABLED=true
```

如果还要跑通群内 PDF 文件下载，需要额外提供：

```env
WECOM_CORP_ID=企业ID
WECOM_APP_SECRET=应用Secret
```

## 本地自测

配置 `.env` 后先运行：

```powershell
npm run smoke:wecom-callback
```

预期输出：

```text
[PASS] GET URL校验：验签和echostr解密成功
[PASS] POST文本消息：验签、解密、业务处理、加密回复成功
[PASS] 候选人入库：张三已写入本地仓储
```

这一步不依赖企业微信公网请求，但能验证项目里的验签、解密、业务处理和加密回复代码。

## 实网联调步骤

1. 启动后端：

```powershell
npm run dev:server
```

2. 用内网穿透把本地 `3001` 暴露成 HTTPS 公网地址，例如：

```powershell
ngrok http 3001
```

3. 企业微信后台配置回调：

```text
URL: https://你的公网域名/api/wecom/aibot/callback
Token: 与 WECOM_BOT_TOKEN 一致
EncodingAESKey: 与 WECOM_BOT_ENCODING_AES_KEY 一致
```

4. 在企业微信后台保存配置，预期 URL 校验成功。

5. 群里发送文本消息：

```text
@招聘助手 张三 Java后端候选人，明天下午一面，王工跟进，手机号13800138000
```

预期结果：

- 后端收到回调并解密。
- 候选人写入数据文件。
- 群里收到处理摘要回复。
- Web 页面候选人看板和消息流出现新数据。

6. 群里发送 PDF 文件消息：

```text
发送 张三简历.pdf
```

如果没有目标岗位，系统会提示补充岗位：

```text
任务 T20260521XXXX：请回复“T20260521XXXX Java后端”
```

用户回复后，系统会自动继续解析原 PDF、做匹配评估并入库。

## 常见问题

- `请先配置 WECOM_BOT_TOKEN`：`.env` 还没填企业微信 Token。
- `invalid signature`：Token、EncodingAESKey、timestamp、nonce 或企业微信后台配置不一致。
- `PDF文件处理失败`：检查 `WECOM_CORP_ID`、`WECOM_APP_SECRET` 和企业微信素材下载权限。
- URL 校验失败：确认公网地址能访问本地 `3001`，并且路径是 `/api/wecom/aibot/callback`。

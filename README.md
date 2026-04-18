# LLMWikiWorker

這個專案會把 LINE webhook 指向 Cloudflare Worker，支援像 `我今天讀了什麼`、`昨天我讀了什麼`、`大前天我讀了什麼`、`4/18 我讀了什麼` 這類查詢。

## Flow

1. LINE 將 webhook event 送到 `POST /webhook`
2. Worker 驗證 LINE signature
3. Worker 使用 Workers AI 解析使用者想查詢的日期
4. Worker 從私有 GitHub repo 讀取 `wiki/log.md`、`wiki/index.md`、`AGENTS.md`、`wiki/rules/query-rules.md`
5. Worker 依指定日期從 `wiki/log.md` 找出當天 `created/updated` 引用，並只收斂 `wiki/summaries/*`
6. Worker 透過 `wiki/index.md` 補齊 slug 對應的 summary 路徑，批次抓取當天 summaries 內容
7. Worker 以 AGENTS + query rules + summaries 內容呼叫 Workers AI 產生摘要
8. Worker 用 LINE reply message 回傳整理結果

## Required Cloudflare Secrets

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GITHUB_TOKEN`

## Required Cloudflare Variables

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_REF`，預設 `main`
- `GITHUB_FILE_PATH`（log path），預設 `wiki/log.md`
- `GITHUB_INDEX_PATH`，預設 `wiki/index.md`
- `GITHUB_AGENTS_PATH`，預設 `AGENTS.md`
- `GITHUB_QUERY_RULES_PATH`，預設 `wiki/rules/query-rules.md`
- `APP_TIMEZONE`，預設 `Asia/Taipei`
- `AI_MODEL`，預設 `@cf/meta/llama-3.1-8b-instruct`

## Local Commands

```bash
npm test
wrangler dev
wrangler deploy
```

## GitHub Actions Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

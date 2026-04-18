# LLMWikiWorker

這個專案會把 LINE webhook 指向 Cloudflare Worker，支援兩種查詢：
- 日期型：`我今天讀了什麼`、`昨天我讀了什麼`、`4/18 我讀了什麼`
- 主題型：輸入一句自然語言問題，AI 會用 `wiki/index.md` 找最相關 summary 再整理回覆

## Flow

1. LINE 將 webhook event 送到 `POST /webhook`
2. Worker 驗證 LINE signature
3. Worker 用本地規則解析使用者日期（不再使用日期 AI）
4. Worker 透過 Workers AI tools 在需要時讀取私有 GitHub repo 的 `wiki/log.md`、`wiki/index.md`、`wiki/rules/review-rules.md`
5. Worker 依指定日期從 `wiki/log.md` 找出當天 `created/updated` 引用，並只收斂 `wiki/summaries/*`
6. Worker 透過 `wiki/index.md` 補齊 slug 對應的 summary 路徑，批次抓取當天 summaries 內容
7. Worker 以精簡 prompt + summaries 內容呼叫 Workers AI 產生摘要
8. Worker 用 LINE reply message 回傳整理結果
9. 若不是日期型查詢，Worker 會改走主題型查詢流程：AI 先從 index 候選中挑出最相關 summary，再整理格式後回覆

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
- `GITHUB_REVIEW_RULES_PATH`，預設 `wiki/rules/review-rules.md`
- `APP_TIMEZONE`，預設 `Asia/Taipei`
- `AI_MODEL`，預設 `@cf/meta/llama-3.1-8b-instruct`
- `SUMMARY_AI_MODEL`（可選），預設同 `AI_MODEL`
- `SUMMARY_TIMEOUT_MS`（可選），預設 `12000`（可不設定）

## Local Commands

```bash
npm test
wrangler dev
wrangler deploy
```

## GitHub Actions Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

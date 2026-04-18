# LLMWikiWorker

這個專案會把 LINE webhook 指向 Cloudflare Worker，支援指令 `我今天讀了什麼`。

## Flow

1. LINE 將 webhook event 送到 `POST /webhook`
2. Worker 驗證 LINE signature
3. 命中 `我今天讀了什麼` 後，Worker 從私有 GitHub repo 讀取 `wiki/log.md`
4. Worker 依 `APP_TIMEZONE` 抓出今天的閱讀紀錄
5. Worker 呼叫 Workers AI 產生摘要
6. Worker 用 LINE reply message 回傳整理結果

## Required Cloudflare Secrets

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GITHUB_TOKEN`

## Required Cloudflare Variables

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_REF`，預設 `main`
- `GITHUB_FILE_PATH`，預設 `wiki/log.md`
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

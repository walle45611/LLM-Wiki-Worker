# LLMWikiWorker

這個專案會把 LINE webhook 指向 Cloudflare Worker，並透過 Queue 在背景執行 AI 查詢與知識庫整理。

目前流程支援：

- 一般 LINE 文字查詢（enqueue 後由 queue consumer 處理）
- 每日排程摘要（enqueue `scheduled_summary` 後由 queue consumer 處理）
- AI 透過 GitHub 私有 repo 讀寫知識庫檔案（`wiki/`）

## Architecture

1. LINE 把事件送到 `POST /webhook`
2. Worker 驗簽成功後，把任務送進 `LLM_WIKI_QUEUE`
3. queue consumer 讀取 job，執行 `buildLineQueryReply()`
4. query agent 透過 tools 讀規則 / 讀檔 / 寫檔
5. 最終訊息送 LINE push

## Queue Jobs

- `line_text_query`
  - 來源：LINE webhook
  - 內容：使用者文字查詢

- `scheduled_summary`
  - 來源：Cloudflare cron (`0 10 * * *`)
  - 內容：`排程任務需要把當天整理結果寫入知識庫`

## AI Tools

- `get_file`
  - 讀取單一檔案內容

- `get_file_tree`
  - 列出路徑下檔案與資料夾

- `upsert_file`
  - 建立或整檔更新 `wiki/` 下檔案

- `append_file`
  - 在 `wiki/` 下檔案尾端附加內容（不存在則建立）

- `replace_in_file`
  - 在 `wiki/` 下檔案中做一次精準文字替換

> 寫檔工具都限制只能寫 `wiki/` 路徑。

## LINE Output Safety

送給 LINE 前會做兩道保護：

1. `stripMarkdown`：用 regex 清理常見 Markdown（標題、粗體、連結、清單、code fence 等）
2. `clampLineText`：超過 4500 字會截斷並補上 `[內容已截斷]`

## Runtime Config

目前查詢與排程共用單一 timeout：

- `eventTimeoutMs = 120000`

## Required Cloudflare Secrets

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GITHUB_TOKEN`

## Required Cloudflare Variables

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_REF`（預設 `main`）
- `APP_TIMEZONE`（預設 `Asia/Taipei`）
- `LINE_TARGET_USER_ID`（排程推播目標）
- `AI_MODEL`（預設 `@cf/openai/gpt-oss-20b`）
- `SUMMARY_AI_MODEL`（可選，預設同 `AI_MODEL`）

## Wrangler Config Highlights

- Cron: `0 10 * * *`（UTC，對應 Asia/Taipei 18:00）
- Queue producer binding: `LLM_WIKI_QUEUE`
- Queue name: `llm-wiki-queue`
- Queue consumer: 同一支 Worker 的 `queue()` handler

## Local Commands

```bash
npm test
wrangler dev
wrangler deploy
```

## GitHub Actions Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

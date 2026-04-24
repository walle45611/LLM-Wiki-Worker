# LLM-Wiki Worker

![LLM-Wiki Worker Architecture](./arch_image.png)

LLM-Wiki Worker 是一個部署在 Cloudflare Workers 上的 Telegram 知識助理。它接收 Telegram webhook，把查詢送進 Cloudflare Queue，由背景 consumer 執行 AI 查詢流程，再透過 Telegram Bot API 回傳結果；同一套流程也支援每日排程整理。

知識內容本身不放在這個 repo，而是讀寫另一個 GitHub repo 的 Wiki 資料庫。這個 Worker 負責：

- 接收 Telegram 訊息
- 讀取外部知識庫 repo 的規則與內容
- 執行 query / ingest / review / daily 等任務
- 以 Telegram 可接受的格式送出回覆

## 流程介紹

1. 收集
   - 來源內容先整理進知識庫 repo 的 `raw/` / `wiki/` 結構。
2. 路由
   - Query agent 先讀知識庫 repo 根目錄的 `AGENTS.md`，再讀 `wiki/rules/router-rules.md` 判斷任務。
3. 執行
   - Agent 用工具讀寫知識庫 repo 中的檔案，只允許寫入 `wiki/`。
4. 背景處理
   - Telegram webhook 與 scheduled job 都先進 `LLM_WIKI_QUEUE`，避免把 AI 推理塞在 request 生命週期內。
5. 回覆
   - Worker 優先將結構化 `blocks` 轉成 Telegram entities；若無法安全渲染，才退回 plain text。

## Architecture

1. Telegram 將更新送到 `POST /webhook`
2. Worker 驗證 `X-Telegram-Bot-Api-Secret-Token`
3. webhook handler 將查詢 enqueue 到 `LLM_WIKI_QUEUE`
4. queue consumer 執行 query agent
5. query agent 讀取外部 GitHub 知識庫 repo 的規則與內容
6. Worker 將 AI 結果轉成 Telegram 訊息並送出

## 專案目錄

- `src/`
  - Worker runtime、Telegram client、GitHub client、AI flow、rules/tool wiring
- `test/`
  - Node test runner 測試
- `templates/`
  - 外部知識庫 repo 會使用的模板來源
- `testing/`
  - 測試輔助工具
- `wrangler.jsonc`
  - Cloudflare Worker、Queue、Cron、vars 設定

## Queue Jobs

- `telegram_text_query`
  - 來源：Telegram webhook 的文字訊息
- `scheduled_summary`
  - 來源：Cloudflare cron
  - 預設 query：`排程任務需要把當天整理結果寫入知識庫`

## AI Tools

- `get_file`
  - 讀取單一檔案內容
- `get_file_tree`
  - 列出指定路徑下的檔案樹
- `upsert_file`
  - 建立或整檔更新 `wiki/` 下檔案
- `append_file`
  - 在 `wiki/` 下檔案尾端附加內容
- `replace_in_file`
  - 在 `wiki/` 下檔案做一次精準文字替換

所有寫入工具都限制在 `wiki/` 路徑下。

## Rule System

這個 Worker 依賴外部知識庫 repo 的規則檔，而不是只靠單一 prompt。

- `templates/AGENTS.md`
  - 外部知識庫 repo 根目錄 `AGENTS.md` 的模板來源
- `templates/wiki/rules/router-rules.md`
  - 任務路由入口
- `templates/wiki/rules/output-rules.md`
  - 最終輸出格式規則
- `templates/wiki/rules/ingest-rules.md`
  - 新知歸檔流程
- `templates/wiki/rules/query-rules.md`
  - 一般查詢與統整
- `templates/wiki/rules/review-rules.md`
  - 今天/昨天/區間回顧
- `templates/wiki/rules/daily-rules.md`
  - 每日整理任務
- `templates/wiki/rules/lint-rules.md`
  - 知識庫健康檢查
- `templates/wiki/rules/social-post-rules.md`
  - 社群貼文生成
- `templates/wiki/rules/log-rules.md`
  - log 寫入相關規則

實務順序：

1. 讀 `AGENTS.md`
2. 讀 `router-rules.md`
3. 依任務讀取需要的 rule files
4. 透過 tools 讀寫知識庫 repo
5. 依 `output-rules.md` 產生最終回覆

## Telegram Output Contract

Worker 目前優先處理結構化輸出：

- AI 理想輸出是合法的 `{"blocks":[...]}`
- 支援的 block type：
  - `heading`
  - `paragraph`
  - `bullet_list`
  - `quote`
  - `code_block`
  - `link`
- Worker 會把 `blocks` 轉成 Telegram `entities`
- 若 entities 送出失敗，會退回 plain text
- 若 AI 沒有產出合法 block payload，才會走純文字回覆

純文字回覆仍會經過限制：

- 超過 3500 字會被截斷
- 含明顯 Markdown 樣式的回覆會被拒絕作為 safe plain-text reply

## Runtime Config

### 必要 secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CHAT_ID`
- `GITHUB_TOKEN`

### 必要 vars

- `GITHUB_OWNER`
- `GITHUB_REPO`

### 可選 vars

- `GITHUB_REF`
  - 預設 `main`
- `APP_TIMEZONE`
  - 預設 `Asia/Taipei`
- `AI_MODEL`
  - 程式預設 `@cf/openai/gpt-oss-20b`
  - 目前 `wrangler.jsonc` 覆寫為 `@cf/google/gemma-4-26b-a4b-it`
- `EVENT_TIMEOUT_MS`
  - 預設 `120000`

### 目前 wrangler.jsonc 重點

- Cron：`0 10 * * *`
  - UTC 10:00，也就是 `Asia/Taipei` 18:00
- Queue binding：`LLM_WIKI_QUEUE`
- Queue name：`llm-wiki-queue`
- Queue consumer retries：`2`

## Commands

依 repo 現況，請使用 Bun：

```bash
bun install --frozen-lockfile
bun run test
node --test --test-concurrency=1 test/query-agent.test.js
node --test --test-concurrency=1 --test-name-pattern="..."
bun run deploy
```

目前 `package.json` 沒有 `dev` script，不要使用 `bun run dev`。

## 初始化與部署

```bash
# 1) 安裝依賴
bun install --frozen-lockfile

# 2) 登入 Cloudflare
bunx wrangler login

# 3) 建立 Queue（只需一次）
bunx wrangler queues create llm-wiki-queue

# 4) 設定 secrets
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
bunx wrangler secret put TELEGRAM_CHAT_ID
bunx wrangler secret put GITHUB_TOKEN

# 5) 部署
bun run deploy
```

部署後，將 Telegram webhook 指向 Worker，並帶上同一組 secret：

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://your-worker-domain/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

`POST /webhook` 會驗證 header `X-Telegram-Bot-Api-Secret-Token`；若和 `TELEGRAM_WEBHOOK_SECRET` 不一致，會直接回 `401 Unauthorized`。

## GitHub Knowledge Repo Wiring

這個 repo 不存放真正的知識內容。Worker 預設讀寫的外部知識庫 repo 由 `wrangler.jsonc` 設定：

- `GITHUB_OWNER=walle4561`
- `GITHUB_REPO=LLM-Wiki`
- `GITHUB_REF=main`

Query agent 會在那個 repo 內讀：

- repo root `AGENTS.md`
- `wiki/rules/router-rules.md`
- 其他被 router 指定的 rules 與 wiki 檔案

## GitHub Actions Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

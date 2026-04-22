# LLM-Wiki Worker

![LLM-Wiki Worker Architecture](./arch_image.png)

## 流程介紹

1️⃣ 收集 (Input)

看到好內容後，先在 Obsidian Web Clipper 端整理成 Markdown（例如 `raw/`、`wiki/` 相關內容），作為知識庫原料；後續規則與摘要都以檔案方式管理，方便 AI 讀取與更新。

2️⃣ AI 提煉 (Processing)

Worker 端的 Query Agent 會先讀 `AGENTS.md` / router rules，再用 tools（`get_file`、`get_file_tree`...）去讀寫知識庫內容，把原始資料提煉成可查詢的 Wiki 結果。

3️⃣ 雙軌同步 (Sync)

知識內容放在 GitHub（LLM-Wiki）供雲端 Worker 讀寫；你本地端可持續用 Obsidian 維護。實務上是「本地編輯 + GitHub 同步」雙軌，確保跨裝置與雲端 AI 一致。

4️⃣ Cloudflare Worker and Worker AI (Serverless)

Telegram webhook 進 Cloudflare Worker 後，事件先進 `LLM_WIKI_QUEUE`，由 queue consumer 背景執行 AI 流程（避免 request 生命週期限制）；排程也走同一條 queue，統一處理模型推理與資料更新。

5️⃣ 分類隔離 (Output)

知識庫與互動輸出分層管理：`raw/` 唯讀、`wiki/` 可維護；最終可回覆的內容由 Worker 產生，並可透過寫檔 tools 直接更新 `wiki/` 下檔案，避免手工筆記與 AI 整理互相干擾。

6️⃣ Telegram 互動 (Query & Reply)

你在 Telegram 提問（如「今天讀了什麼」）後，Worker 會從 queue 取任務、讀取 GitHub 知識庫、整理回覆再回傳到 Telegram；訊息送出前會做長度控制，避免超出聊天平台限制。

## 專案初衷

這個專案的起點很單純：我們每天都會看到很多有價值的內容，可能是一篇網頁文章、也可能是一支 YouTube 影片。當下看完覺得很有收穫，就先存進筆記裡，想著「之後一定用得到」。

但真實情況是，過了一段時間後，記憶只剩下一個模糊印象：
你知道自己「好像看過這件事」，卻說不清在哪裡看到、重點是什麼、當初為什麼重要。

LLM-Wiki Worker 就是為了解決這個而生。

它想做的不只是「幫你保存資料」，而是把那些沉在筆記深處、快被遺忘的網頁與影片內容，轉成可以被查詢、被串接、被持續更新的活資料。當你再次想起某個模糊線索時，它能幫你把記憶拉回來，整理成你現在就能用的答案。

這個專案會把 Telegram webhook 指向 Cloudflare Worker，並透過 Queue 在背景執行 AI 查詢與知識庫整理。

目前流程支援：

- 一般 Telegram 文字查詢（enqueue 後由 queue consumer 處理）
- 每日排程摘要（enqueue `scheduled_summary` 後由 queue consumer 處理）
- AI 透過 GitHub 私有 repo 讀寫知識庫檔案（`wiki/`）

## Architecture

1. Telegram 把事件送到 `POST /webhook`
2. Worker 解析 webhook payload 後，把任務送進 `LLM_WIKI_QUEUE`
3. queue consumer 讀取 job，執行 query agent
4. query agent 透過 tools 讀規則 / 讀檔 / 寫檔
5. 最終訊息送 Telegram Bot API

## 專案第一層目錄用途

- `src/`
  - Worker 主程式與核心邏輯（webhook、queue、排程、AI 流程、Telegram client、GitHub client、rules 執行）

- `test/`
  - Node test runner 測試檔，覆蓋主要流程與工具行為

- `templates/`
  - 知識庫模板與規則模板來源
  - 包含 `templates/AGENTS.md` 與 `templates/wiki/rules/*.md`

- `.github/`
  - CI/CD 工作流程（例如 deploy workflow）

- `wrangler.jsonc`
  - Cloudflare Worker 設定（AI binding、Queue producer/consumer、cron、vars）


## Queue Jobs

- `telegram_text_query`
  - 來源：Telegram webhook
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

## Rule System（templates）

這個專案的行為不是只靠 prompt，而是靠一組可組合的規則檔：

- 入口：`templates/AGENTS.md`
- 路由：`templates/wiki/rules/router-rules.md`
- 任務規則：`templates/wiki/rules/*.md`

### `templates/AGENTS.md` 在做什麼

`templates/AGENTS.md` 是總控規範，主要定義：

1. 角色與工作邊界
   - 預設是知識庫自動維護者
   - `raw/` 唯讀、`wiki/` 可維護
2. 強制流程
   - 每次任務第一步都先讀 `wiki/rules/router-rules.md`
   - 依 router 判斷任務，再讀所有必要 rules
3. 工具與寫入限制
   - 路徑不明確要先確認，不可猜
   - 未讀完必要規則前不可寫入
4. 完成回報與禁止事項
   - 若有寫檔要回報寫了什麼、寫到哪、依據哪些規則
   - 禁止假裝完成、禁止把推測當事實

### `templates/wiki/rules/` 各檔案用途

- `router-rules.md`
  - 規則路由中心，先決定本次任務屬於哪一類（B~G）
  - 也包含前置規則（例如 output 規則、log 規則）

- `output-rules.md`
  - 專門管「輸出格式」
  - 明確區分：寫入檔案可用 Markdown、回覆使用者必須純文字（預設 zh-TW）

- `ingest-rules.md`
  - 新知攝取流程（整理/摘要/歸檔）
  - 重點是把來源編譯進 `wiki/`，並更新 `index.md`、追加 `log.md`

- `query-rules.md`
  - 查詢與統整流程
  - 先用 `index.md` 找路，再讀 `concepts/`、`summaries/`，必要時回寫高價值整合內容

- `lint-rules.md`
  - 知識庫健康檢查與維護
  - 檢查矛盾、孤立頁、重複內容、索引同步、知識空缺

- `review-rules.md`
  - 時間回顧型查詢（今天/昨天/區間）
  - 單日與短區間優先走 `index.md` + `summaries/`，長區間優先走 `wiki/assets/daily/`

- `daily-rules.md`
  - 每日整理任務（建立或更新 `wiki/assets/daily/YYYY-MM-DD.md`）
  - 定義 daily 內容格式、寫入方式（`upsert_file`）與後續 log 規範

- `social-post-rules.md`
  - 社群貼文生成任務
  - 把文章重點轉成可發送文案，重視可讀性、情緒價值、來源可追溯

### 規則運作順序（實務）

1. 讀 `AGENTS.md`
2. 讀 `router-rules.md`
3. 依 router 讀一個或多個 task rule
4. 依規則使用 tools 執行讀檔 / 寫檔
5. 依 `output-rules.md` 決定最終回覆格式

## Telegram Output Safety

送給 Telegram 前會做長度保護：

1. `clampChatText`：超過 3500 字會截斷並補上 `[內容已截斷]`

## Runtime Config

目前查詢與排程共用單一 timeout：

- `eventTimeoutMs = 120000`

## Required Cloudflare Secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `GITHUB_TOKEN`

## Required Cloudflare Variables

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_REF`（預設 `main`）
- `APP_TIMEZONE`（預設 `Asia/Taipei`）
- `AI_MODEL`（預設 `@cf/openai/gpt-oss-20b`）

## Wrangler Config Highlights

- Cron: `0 10 * * *`（UTC，對應 Asia/Taipei 18:00）
- Queue producer binding: `LLM_WIKI_QUEUE`
- Queue name: `llm-wiki-queue`
- Queue consumer: 同一支 Worker 的 `queue()` handler

## 初始化環境（第一次部署）

```bash
# 1) 登入 Cloudflare
bunx wrangler login

# 2) 建立 Queue（只需一次）
bunx wrangler queues create llm-wiki-queue

# 3) 確認 Queue 已建立
bunx wrangler queues list

# 4) 設定必要 secrets
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
bunx wrangler secret put GITHUB_TOKEN

# 5) 部署 Worker（會套用 wrangler.jsonc 的 queue producer/consumer 綁定）
bun run deploy
```

若你要在 Cloudflare Dashboard 直接維護變數，請確認以下 vars 與 `wrangler.jsonc` 一致：

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_REF`
- `APP_TIMEZONE`
- `AI_MODEL`

初始化後可用以下方式快速驗證：

```bash
# 本地開發（含 API）
bun run dev

# 追 Cloudflare 線上 log
bunx wrangler tail
```

## Local Commands

```bash
bun test
bun run dev
bun run deploy
```

## GitHub Actions Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

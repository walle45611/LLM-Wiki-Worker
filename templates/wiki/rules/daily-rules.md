# Daily Rules

## 任務目標

任務目標是建立或更新 `wiki/assets/daily/YYYY-MM-DD.md`
## 輸入資料

在寫入 daily 檔案前，必須先取得以下資訊：

1. 從 `wiki/index.md` 的 `Summaries` 區塊確認當日有哪些 summary 條目。
2. 依照 `## Summaries` 條目中的日期與路徑，打開對應的 `wiki/summaries/...` 頁面。
3. 這類情況應以 `wiki/summaries/...` 為主，因為需要較細的逐篇資訊。

## 輸出路徑

輸出檔案路徑必須固定為：

`wiki/assets/daily/YYYY-MM-DD.md`

例如：

- `wiki/assets/daily/2026-04-17.md`
- `wiki/assets/daily/2026-04-21.md`

## 檔案格式

輸出內容必須是合法的 Markdown。

輸出檔案盡可能要包含以下內容：

```md
# Daily Digest <日期>

- date: <日期>
- timezone: Asia/Taipei
- generated_at: <日期>
-  basis: <參考到的檔案或是依據>，可以使用此格式 [[為檔案的位置]]

## Summary

- 日期開場白  
  例如：`📅 這是您在 使用者傳入的時間可能是範圍或是某天 的知識庫攝取紀錄：`
- 閱讀總覽  
  例如：`📚 共整理了 2 篇內容。`
- 逐篇摘要  
  每篇包含：
  - 主題名稱
  - `source link`
  - 1 句話核心概念
  - 3 到 5 個重點
- 知識串聯（可選）  
  若同一天或同一區間內幾篇內容有明顯關聯，可補上一句整體觀察。
```

- 其中 `source link` 應優先代表外部原始來源網址；若同時需要本地素材位置，可額外附上 `source: raw/...`。

## 寫入規則

1. 最終檔案必須使用 `upsert_file` 寫入。
2. 寫入路徑必須位於 `wiki/assets/daily/` 之下。
3. 檔案內容可以使用一般 Markdown 語法。
4. 同一天的 daily 應更新同一份檔案，不應建立多份重複檔案。
5. 若資料不足，不得自行補寫或猜測缺漏內容。
6. 只能寫入已實際讀取與整理過的內容。

## 輸出規則

1. 最終輸出格式請依 `wiki/rules/output-rules.md`。

## Worker 對使用者的回覆規則

若本次任務以 `LLM-Wiki-Worker` 執行，且檔案成功寫入後：

- 不要把完整 Markdown 檔案內容直接回傳給使用者
- 只回覆精簡的純文字確認訊息
- 回覆中應提供可直接開啟該檔案的 Obsidian 連結，而不只是一般檔案路徑
- 若同時需要顯示位置，可在 Obsidian 連結後補充對應的 vault 內相對路徑

例如：已更新 obsidian://open?vault=LLM%20Wiki&file=wiki%2Fassets%2Fdaily%2F2026-04-21.md

## Log 規則

在 `wiki/assets/daily/YYYY-MM-DD.md` 成功建立或更新後：

1. 必須同步更新 `wiki/log.md`。
2. log 必須記錄這次 daily 任務已執行，並指出更新的 daily 檔案路徑與依據來源。
3. 若 daily 檔未成功寫入，禁止先聲稱 log 已完成。

建議 daily log 格式：

```md
## [YYYY-MM-DD] daily | <date-or-topic>

- basis: <key pages>
- updated: <daily file path>
- notes: <summary count, linkage, or gaps>
```

## 失敗處理

若出現以下情況：

- 目標日期不明確
- 必要來源資料不足
- 檔案寫入失敗

則必須：

1. 直接說明問題
2. 不得捏造內容
3. 若 `upsert_file` 未成功，禁止聲稱檔案已建立或更新
4. 若 daily 寫入未成功，禁止更新 `wiki/log.md` 後再假裝整體流程已完成

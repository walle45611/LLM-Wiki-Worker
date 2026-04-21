# Ingest Rules

本檔定義「攝取新知」時的標準作業流程。目標不是把原始文件切塊後等查詢時再重組，而是把新來源消化後，直接編譯進 `wiki/`，讓知識庫成為持續累積、可交叉連結、可被維護的 Markdown wiki。

## 任務目標

當使用者要求「整理」、「摘要」、「歸檔」新來源，或把新檔案放入 `raw/` 時，你要：

1. 讀取來源。
2. 提取關鍵資訊、主張、定義、實體、概念、證據與限制。
3. 將資訊寫入或整合到 `wiki/` 的既有頁面中。
4. 建立必要的新頁面與交叉連結。
5. 更新 `wiki/index.md`。
6. 追加一筆 `wiki/log.md` 記錄。

## 硬性規則

1. `raw/` 是唯讀來源區，只能讀，不能改、不能移、不能重新命名。
2. `wiki/` 是工作區，所有整理、整合、修訂都只能發生在這裡。
3. 新檔名一律使用小寫 kebab-case。
4. 先整合既有頁面，再決定是否新建頁面；避免每個來源都生成孤立新頁。
5. 摘要必須保留來源邊界；跨來源結論應寫進概念頁，不要混在單一來源摘要裡假裝是原文觀點。
6. 如果新來源與舊內容矛盾，要明確標註矛盾與來源，不可偷偷覆蓋舊說法。

## 讀取順序

執行 ingest 前，依序讀：

1. `wiki/index.md`
2. 與該主題最可能相關的 `wiki/summaries/` 與 `wiki/concepts/` 頁面
3. 必要時讀 `wiki/log.md` 最近幾筆，以了解最近是否剛處理過相同主題

## 輸出策略

### 1. 單一來源摘要

每個新來源，優先在 `wiki/summaries/` 建立或更新一個對應摘要頁。摘要頁用途是保存「這份來源本身說了什麼」。

摘要頁應盡量包含：

- 來源標題
- 來源路徑或來源識別資訊
- 摘要
- 關鍵主張
- 重要事實或數據
- 值得追蹤的名詞、實體、概念
- 與既有知識庫內容的一致、補強、衝突或空缺
- 指向相關概念頁的連結

其中來源欄位採以下規則：

- 若來源來自 vault 內 `raw/`，摘要頁必須明確寫出 `- source: \`raw/...\``` 
- 若對應 `raw/...` 已記錄外部原始網址，摘要頁必須另外寫出 `- source link: <external url>`
- 優先保留 `raw/` 下的原始相對路徑，不要只寫模糊標題
- 不可把 `raw/` 來源省略後只留在 `wiki/log.md`；summary 本身就要能獨立指出原始來源
- `source` 與 `source link` 的用途不同：`source` 是 vault 內素材位置，`source link` 是外部網站、影片或文件的真正出處
- 若來源不是本地 `raw/` 檔，而是外部文章或網址，也要在摘要頁保留可追溯的來源識別資訊

建議最小格式：

```md
# <source title>

- source: `raw/example-source.md`
- source link: https://example.com/original-source
- original title: <original title>
- author: <author or not specified>
- published: <date or not specified>
- type: <source type>
```

### 2. 概念整合

若新來源補強、修正或擴展某個既有主題，更新 `wiki/concepts/` 下對應概念頁。

概念頁用途是保存「目前知識庫整體怎麼看這件事」。

更新概念頁時：

- 優先保留穩定、可跨來源成立的結論
- 重要爭議要列出分歧，而不是假裝已有定論
- 補上到相關摘要頁的連結
- 補上與相鄰概念的雙向連結

### 3. 只在必要時新建概念頁

符合下列任一條件時可以新建概念頁：

- 新來源引入知識庫中尚未成頁、但會反覆出現的核心概念
- 同一名詞已在多頁出現，值得獨立成頁
- 這個主題未來很可能會持續累積多來源內容

如果只是一次性細節，先放在摘要頁或現有概念頁，不必拆頁。

## 交叉連結規則

1. 每次 ingest 至少補齊這三類連結：
   - 新摘要頁 -> 相關概念頁
   - 被更新的概念頁 -> 新摘要頁
   - 相關概念頁彼此之間的連結
2. 不要只新增頁面卻不掛回既有結構。
3. 若某頁提到重要名詞，但該名詞已有頁面，應補上連結。

## `index.md` 更新規則

`wiki/index.md` 是內容導向的總索引。每次 ingest 都必須更新。

硬性要求：

1. 只要本次任務有新增或更新任何 `wiki/summaries/*.md`，就必須同步更新 `wiki/index.md` 的 `## Summaries` 區塊。
2. `summary` 條目必須寫在 `## Summaries` 標題下，不能寫到其他區塊。
3. `concept` 條目必須寫在 `## Concepts` 標題下，不能混入 `## Summaries`。
4. `## Summaries` 區塊中的每個 summary 條目都必須使用固定格式：`- [slug](./summaries/slug.md) · YYYY-MM-DD: description`
5. 上述格式中的日期必須使用該 summary 被收錄進 LLM Wiki 的日期，也就是 `created`，不可改用來源原始發布日期。
6. 若 `wiki/index.md` 尚未有 `## Summaries` 或 `## Concepts` 區塊，必須先補齊區塊，再插入條目。
7. 若對應條目已存在，應更新原條目，不要重複新增。
8. 不可只在 `wiki/log.md` 記錄 summary 變更而省略 `wiki/index.md`。
9. 需要維護：
   - `summaries/` 下新增或更新的頁面條目
   - `concepts/` 下新增的概念頁條目
   - 必要時更新一行描述，讓後續查詢能先靠 index 找路，再深入讀頁面

欄位格式要求：

1. `slug` 必須對應 summary 頁檔名，不含 `.md`。
2. `path` 必須寫成 `./summaries/<slug>.md`。
3. `description` 必須是一句可快速掃描的內容描述，說明這篇 summary 整理了什麼。

條目描述應短、資訊密度高，方便快速掃描。

## `log.md` 更新規則

`wiki/log.md` 是時間序列紀錄。每次 ingest 都要追加，不覆蓋舊紀錄。

建議格式：

```md
## [YYYY-MM-DD] ingest | <source-title>

- source: <raw path or external source>
- created: <new pages>
- updated: <updated pages>
- notes: <key effect on the wiki>
```

## 品質要求

1. 摘要要壓縮冗言，但不能壓掉關鍵條件、限制與不確定性。
2. 若來源含數據、版本、時間點、適用條件，應保留。
3. 不要把聊天中的推測寫成已確認事實。
4. 若使用者有特別關心角度，優先反映在摘要與概念整合中。
5. 摘要頁必須保留可追溯的原始來源欄位，讓後續 review / query 不必再回頭猜測或重建來源路徑。

## 輸出規則

1. 最終輸出格式請依 `wiki/rules/output-rules.md`。

## 何時停止

一次 ingest 在以下條件成立時可視為完成：

1. 新來源已有對應摘要頁。
2. 受影響的概念頁已更新，或已明確判斷無需更新。
3. 主要交叉連結已補上。
4. `wiki/index.md` 已更新。
5. 若本次有新增或更新任何 `wiki/summaries/*.md`，則 `wiki/index.md` 的 `## Summaries` 區塊中必須已有對應條目，且格式正確。
6. `wiki/log.md` 已追加紀錄。

## 不要做的事

1. 不要修改 `raw/`。
2. 不要把所有內容都做成單頁長摘要，卻不回寫到概念層。
3. 不要只新增頁面，不更新 index 與 log。
4. 不要因為新來源較新，就無註記地覆蓋舊結論。
5. 不要為了完整而過度拆頁，導致 wiki 變得碎裂。

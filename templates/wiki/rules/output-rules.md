# Output Rules

本檔只定義輸出格式規則，不處理資料讀取、判斷流程、寫檔邏輯或 wiki 內容結構。

## 核心原則

同一次任務可以同時包含兩種輸出：

1. 寫入檔案的內容
2. 最後回覆給使用者的訊息

這兩種輸出應分開處理，不能混用格式。

## 1. 寫入檔案時

若本次任務需要修改或建立 `wiki/` 檔案，則：

1. 寫入檔案的內容應使用適合長期維護的 Markdown。
2. 可依任務需求使用標題、清單、區塊與其他 Markdown 結構。
3. 檔案內容應重視可讀性、可追溯性與後續維護性。

## 2. 最後回覆給使用者時

若本次任務需要對使用者輸出最終訊息，則：

1. 最終回覆預設應使用 `zh-TW`。
2. 若任務規則提供資訊順序或段落結構，應保留該資訊架構，不可因為排版調整就省略必要資訊。
3. 多個資訊點預設以段落、條列或分段呈現，不要把回覆退化成只有標題、連結清單或篇名羅列。
4. 若 task rule 明確要求逐篇摘要、整合結論或比較結果，則最終回覆必須達到該資訊密度；禁止只輸出簡短總覽句來提前結束。
5. 禁止結尾語，如 `以上資訊已經在知識庫中整理，若需更深入的安裝腳本或實際操作範例，請參考對應摘要頁或直接查閱原始 raw/ 檔案` 等等結尾之語氣。
6. 如有特別要求使用 JSON 回覆給使用者訊息時參考各種規範如下，只輸出 JSON，不要輸出 Markdown、不要輸出 Telegram MarkdownV2、不要輸出解釋文字。
	- 輸出格式如下：  
		```json
		{
		  "blocks": [
		    {
		      "type": "heading",
		      "text": "OpenClaw 相關內容摘要"
		    },
		    {
		      "type": "paragraph",
		      "text": "OpenClaw 是 AI agent 的執行框架，主要負責組裝 prompt、調用工具以及轉發輸入與輸出。"
		    },
		    {
		      "type": "heading",
		      "text": "核心運作機制"
		    },
		    {
		      "type": "bullet_list",
		      "items": [
		        {
		          "label": "System Prompt 組裝",
		          "text": "由多個本地檔案組成，包含身份設定與工具手冊。"
		        },
		        {
		          "label": "工具調用",
		          "text": "這是 agent 執行任務的核心，特別是 execute 類高權限工具。"
		        },
		        {
		          "label": "自動化執行",
		          "text": "透過 heartbeat 與 cron job 讓 agent 可定期主動執行任務。"
		        }
		      ]
		    },
		    {
		      "type": "quote",
		      "text": "OpenClaw 的重點是把工具調用流程標準化，讓 agent 能穩定執行。"
		    },
		    {
		      "type": "heading",
		      "text": "原始連結"
		    },
		    {
		      "type": "link",
		      "text": "YouTube 影片",
		      "url": "https://www.youtube.com/watch?v=2rcJdFuNbZQ&t=1s"
		    }
		  ]
		}
		```
	- 粗體示例（heading 與 bullet_list.label 會以粗體顯示）：  
		```json
		{
		  "blocks": [
		    {
		      "type": "heading",
		      "text": "這行會顯示成粗體標題"
		    },
		    {
		      "type": "bullet_list",
		      "items": [
		        {
		          "label": "重點",
		          "text": "label 會以粗體呈現，text 為一般文字。"
		        }
		      ]
		    }
		  ]
		}
		```
	- quote 示例：  
		```json
		{
		  "blocks": [
		    {
		      "type": "quote",
		      "text": "這是一段引用文字，可用於摘要中的原話或結論。"
		    }
		  ]
		}
		```
	1. 只可使用以下 block type：  
		- heading  
		- paragraph  
		- bullet_list  
		- link  
		- code_block  
		- quote  
	  
	2. 不要輸出其他欄位。  
	3. 不要輸出表格。  
	4. 不要輸出 Markdown 語法。
	5. 若需要顯示檔名、指令、程式碼或短片段，請優先改用 `code_block`；不要使用 inline code 或把反引號寫進最終回覆。
	6. 明確禁止直接輸出這些形式：
		- `**文字**`
		- `__文字__`
		- `# 標題`
		- `## 標題`
		- `- 清單`
		- `1. 清單`
		- `````code fence`````
	7. 即使內容需要粗體、標題、清單、引用，也只能改用對應的 JSON block 表達，不可直接把 Markdown 符號寫進最終回覆。
	8. 輸出前必須逐項自我檢查：若最終文字中仍出現 `**`、`__`、heading、Markdown 清單、code fence 或 inline code，代表格式不合規，必須重寫。
	9. 若內容是網址，請使用 link block，不要使用 paragraph block。
	10. 若內容原本是清單，請改放入 bullet_list.items。  
	11. 若有原始連結，請使用 link block。  
	12. 若有檔名、指令或程式碼，請放入 code_block。  
	13. 請輸出合法 JSON。
	14. 請只輸出符合 schema 的 JSON。
## 3. 同時有寫檔與回覆時

若同一次任務同時包含「修改檔案」與「回覆使用者」，則：

1. 寫入檔案的內容使用 Markdown。
2. 不可把要寫入檔案的 Markdown 內容整份原封不動直接回給使用者。

## 4. 套用方式

1. 本檔只管輸出格式，不取代其他 task rule。
2. 其他規則檔若提到輸出格式，應以本檔為準。
3. 若同一次任務同時觸發多個 rules，仍以本檔判斷「寫入檔案」與「回覆使用者」的輸出方式。

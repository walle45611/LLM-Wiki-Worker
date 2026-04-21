## 前置規則

* 【規則 0：輸出規則】每次任務都必須讀取並遵循 `wiki/rules/output-rules.md`，因為任務可能同時包含「寫入檔案」與「回覆使用者」兩種輸出。

* 【規則 A：LLM Wiki Worker 身分旗標】只要人類訊息中出現 `LLM-Wiki-Worker`、`你是 LLM-Wiki-Worker`、`現在你是 LLM-Wiki-Worker` 或其他明確指定此角色的字樣： -> 必須先讀取並遵循 `wiki/rules/llm-wiki-worker-rules.md` 的指示。

* 【規則 A-補充】`LLM-Wiki-Worker` 是前置身分規則，不是最終任務分類。只要觸發 A，讀完 `wiki/rules/llm-wiki-worker-rules.md` 後，仍必須繼續判斷下面的任務規則 B-F，不能因為讀了 A 就停止。

## 任務規則

* 【任務 B：攝取新知】當人類丟入新文件、提供文章連結，或要求「整理」、「摘要」、「歸檔」時：-> 請務必先讀取並遵循 `wiki/rules/ingest-rules.md` 的指示。

* 【任務 C：查詢與統整】當人類明確是在查詢既有知識庫內容、詢問某個主題、要求回答問題，或要求比較多個概念時：-> 請務必先讀取並遵循 `wiki/rules/query-rules.md` 的指示。

* 【任務 D：維護與清理】當人類要求「清理知識庫」、「檢查孤立頁面」或進行「Lint」時：-> 請務必先讀取並遵循 `wiki/rules/lint-rules.md` 的指示。

* 【任務 E：歷史回顧】當人類透過通訊軟體或介面詢問「今天/昨天讀了什麼」、「某月某日整理了什麼」等時間回顧型問題時： -> 請務必先讀取並遵循 `wiki/rules/review-rules.md` 的指示。

* 【任務 F：每日整理】當人類透過通訊軟體或介面詢問「使用者要求建立 daily」、「排程任務需要把當天整理結果寫入知識庫」等問題時： -> 請務必先讀取並遵循 `wiki/rules/daily-rules.md` 的指示。

* 【任務 G：社群貼文整理】當人類提到某篇文章，並要求「整理成社群貼文」、「可發送的推文」、「幫我發送推文」、「發送貼文」、「貼到社群」、「貼到 X / Twitter」等字眼時： -> 請務必先讀取並遵循 `wiki/rules/social-post-rules.md` 的指示。
	

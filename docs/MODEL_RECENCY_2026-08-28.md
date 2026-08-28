# 型號時效查核快照 —— 2026-08-28

> 續 [MODEL_RECENCY_2026-08-12.md](MODEL_RECENCY_2026-08-12.md) 的第二次查核。
> 觸發原因：`GEMINI_V1BETA_LATENCY_COST_DIAGNOSIS_2026-08-28.md` 主張 Google 於
> 2026-08-26 發布新的即時轉錄型號，需要獨立證據確認現行 pin 是否仍為最新。
> **本檔是查核當日快照，不是永久保證。** 引用時必須連日期一起引。

## 查核方法

唯讀 GET，未送出任何音訊、未燒轉譯配額。key 取自系統環境變數（STRICT 政策），
本檔只記錄型號與日期，**不記錄任何 key 值或片段**。

OpenAI 側依 `services/online/src/openai-keys.ts` 的同一套規則取 key：
主 slot 優先，遇 401／403 改用 alternate slot。這次確實走到了那條路——

| 供應商 | 端點                                                          | key slot         | HTTP | 回應總數 |
| ------ | ------------------------------------------------------------- | ---------------- | ---- | -------- |
| OpenAI | `GET https://api.openai.com/v1/models`                        | `primary`        | 401  | —        |
| OpenAI | 同上（自動改用 alternate）                                    | `audio`          | 200  | 124      |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` | `GEMINI_API_KEY` | 200  | 53       |
| Gemini | `GET .../v1alpha/models`                                      | 同上             | 200  | 54       |
| Gemini | `GET .../v1/models`                                           | 同上             | 200  | 19       |

`primary`（`sk-svcacct`）的 401 是 `ip_not_authorized`，與 `DECISIONS.md` D12
記錄的企業 IP 允許清單同一個成因，**不是新問題**。

## OpenAI —— realtime／transcribe 家族（依 `created` 由新到舊）

| 型號                         | created    | 定位                     |
| ---------------------------- | ---------- | ------------------------ |
| `gpt-live-transcribe`        | 2026-07-27 | 轉錄專用（非翻譯）       |
| `gpt-transcribe`             | 2026-07-27 | 轉錄專用（非翻譯）       |
| `gpt-realtime-2.1-mini`      | 2026-06-23 | 通用對話 realtime        |
| `gpt-realtime-2.1`           | 2026-06-23 | 通用對話 realtime        |
| `gpt-realtime-whisper`       | 2026-05-05 | 轉錄專用                 |
| `gpt-realtime-2`             | 2026-05-05 | 通用對話 realtime        |
| **`gpt-realtime-translate`** | 2026-05-05 | **翻譯專用（現行 pin）** |
| `gpt-realtime-1.5`           | 2026-02-19 | 通用對話 realtime        |

全清單中 id 含 `translat` 的**只有一個**：`gpt-realtime-translate`，且無任何日期後綴變體。
比 pin 更新的四個型號都不是翻譯專用：`gpt-live-transcribe`／`gpt-transcribe`／
`gpt-realtime-whisper` 是轉錄路徑；`gpt-realtime-2.1` 系列是通用對話 realtime，
依 CLAUDE.md「Do Not Use GPT-Realtime-2 as the Main Caption Engine」不得當主字幕引擎。

## Gemini —— live 家族

| 型號                                           | 支援方法              | 定位                         |
| ---------------------------------------------- | --------------------- | ---------------------------- |
| **`models/gemini-3.5-live-translate-preview`** | `bidiGenerateContent` | **翻譯專用（現行 pin）**     |
| `models/gemini-3.5-transcribe-live`            | `bidiGenerateContent` | 轉錄專用（08-12 快照時未有） |
| `models/gemini-3.5-transcribe`                 | `generateContent`     | 轉錄專用（08-12 快照時未有） |
| `models/gemini-3.1-flash-live-preview`         | `bidiGenerateContent` | 通用 live（版號較舊）        |

兩個新的 `transcribe` 型號是 STT，**不直接產生翻譯**，因此不是現行 pin 的升級候選。
清單中唯一的 live-translate 型號仍是現行 pin。

`v1alpha` 今天仍回 200 且多列一個 `models/lyria-realtime-exp`，
因此 **v1alpha 尚未下線**；`v1` 不含任何 live 型號。
這使 v1beta 遷移維持在「相容性與安全性」而非「服務中斷」的優先度上，
與 `GEMINI_V1BETA_LATENCY_COST_DIAGNOSIS_2026-08-28.md` §4.4 的結論一致。

## 結論（E 區範圍內）

兩條線上路徑的現行 pin，在 2026-08-28 當日**都仍是各自供應商唯一的專用即時翻譯型號**，
沒有更新的同類替代品。

**閘門 G1：未觸發。** 觸發條件是「查出更新的專用翻譯型號」，本次沒有。
`PHASE_2_RUN.md` 序 0-E2 的裁決（維持雙 pin）在今天依然成立。

## 誠實的限制

- **08-12 記 130 個 OpenAI 型號，今天記 124 個。** 兩次用的 key slot 與網路位置不同，
  可見型號集合本來就會不同。**這個差額無法歸因**，不得解讀為「OpenAI 下架了 6 個型號」。
  上面的翻譯型號判定不依賴總數，只依賴「id 含 `translat` 者僅一個」這項直接觀察。
- Gemini 清單端點不回傳建立日期，故該表以版號與定位判斷，未列日期欄——
  這是端點的資料限制，不是漏查。
- 診斷報告主張兩個 transcribe 型號的發布日為 2026-08-26。清單端點無日期欄位，
  **本次未獨立驗證該日期**；只驗證了「08-12 快照沒有、08-28 有」。
- 本次查核**沿用 E 區既有範圍**（即時翻譯專用型號）。查核過程中另外觀察到
  `services/online/src/routes/translate.ts` 的 Hybrid 文字翻譯 pin 為 `gpt-4.1-mini`
  （今天仍在清單中，未下架），而同帳號已有較新的 `gpt-5.4-mini`／`gpt-5.4-nano`。
  該 pin **不在 `GOAL_PHASE_2.md` §E 的「最新專用模型」裁決範圍內**，
  故本檔僅記錄觀察，不作判定，也不構成改動依據——要換必須先有翻譯品質與延遲的量測。

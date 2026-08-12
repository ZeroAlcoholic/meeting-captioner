# 型號時效查核快照 —— 2026-08-12

> P2-ONLINE 序 0／E1 的證據落檔。契約見 [PHASE_2_RUN.md](PHASE_2_RUN.md)，任務定義見 [GOAL_PHASE_2.md](GOAL_PHASE_2.md) E 區。
> **本檔是查核當日快照，不是永久保證。** 引用時必須連日期一起引。

## 查核方法

唯讀 GET，未送出任何音訊、未燒轉譯配額。key 取自系統環境變數（STRICT 政策），
本檔只記錄型號與日期，**不記錄任何 key 值或片段**。

| 供應商 | 端點                                                          | 回應總數 |
| ------ | ------------------------------------------------------------- | -------- |
| OpenAI | `GET https://api.openai.com/v1/models`                        | 130      |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` | 52       |

兩路清單端點都**有**列出現行 pin 的型號，因此 GOAL 裡「preview／live 型號可能不入清單、
需改查官方文件頁」的備援路徑本次未觸發。

## OpenAI —— realtime 家族（依 `created` 由新到舊）

| 型號                         | created    | 定位                     |
| ---------------------------- | ---------- | ------------------------ |
| `gpt-live-transcribe`        | 2026-07-27 | 轉錄專用（非翻譯）       |
| `gpt-realtime-2.1`           | 2026-06-23 | 通用對話 realtime        |
| `gpt-realtime-2.1-mini`      | 2026-06-23 | 通用對話 realtime        |
| **`gpt-realtime-translate`** | 2026-05-05 | **翻譯專用（現行 pin）** |
| `gpt-realtime-2`             | 2026-05-05 | 通用對話 realtime        |
| `gpt-realtime-whisper`       | 2026-05-05 | 轉錄專用                 |
| `gpt-realtime-1.5`           | 2026-02-19 | 通用對話 realtime        |
| `gpt-realtime-mini`          | 2025-10-03 | 通用對話 realtime        |
| `gpt-realtime`               | 2025-08-27 | 通用對話 realtime        |

全清單中 id 含 `translat` 的**只有一個**：`gpt-realtime-translate`，且無任何日期後綴變體
（例如沒有 `gpt-realtime-translate-2` 或 `-2026-xx-xx`）。

**比 pin 更新的三個型號都不是翻譯專用**：`gpt-live-transcribe` 與 `gpt-realtime-whisper`
是轉錄路徑；`gpt-realtime-2.1` 系列是通用對話 realtime，依 CLAUDE.md
「Do Not Use GPT-Realtime-2 as the Main Caption Engine」不得當主字幕引擎，
E 區邊界也明文排除通用對話模型。

## Gemini —— live 家族

| 型號                                           | 支援方法              | 定位                     |
| ---------------------------------------------- | --------------------- | ------------------------ |
| **`models/gemini-3.5-live-translate-preview`** | `bidiGenerateContent` | **翻譯專用（現行 pin）** |
| `models/gemini-3.1-flash-live-preview`         | `bidiGenerateContent` | 通用 live（版號較舊）    |

全清單中唯一的 live-translate 型號即現行 pin。另一個 live 型號版號較低（3.1 < 3.5）
且非翻譯專用，不構成升級候選。

（Gemini 清單端點不回傳建立日期，故本表以版號與定位判斷，未列日期欄——
這是該端點的資料限制，不是漏查。）

## 結論（E1 範圍內）

兩條線上路徑的現行 pin，在 2026-08-12 當日**都是各自供應商唯一的專用即時翻譯型號**，
且沒有更新的同類替代品。E2 的裁決見下節。

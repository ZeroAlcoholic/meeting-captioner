# NVIDIA 本機即時英語→台灣繁體中文候選調研

日期：2026-11-03。範圍：NVIDIA 官方模型卡、文件、GitHub 與官方文章的桌面查證；**未下載／執行模型、未變更 provider、未量測本機速度或品質**。

## 結論

最值得先試的是 **Riva Translate 4B Instruct v2 的文字英→繁中翻譯**，先接現有 finalized 英文稿，隔離確認 MT 收益；再比較 **Nemotron Speech Streaming EN 0.6B** 是否能改善英文來源 ASR。兩者組成「英語音→英文文字→繁中」管線，不能稱為單一小模型直接同步口譯。

NVIDIA 官方 NeMo-Speech.cpp 已有 Windows 原生安裝路線、CPU／CUDA／Vulkan、本機串流 ASR 與 Riva v2 MT，可優先做獨立 sidecar 實驗；不必先承擔 Linux／NIM 部署。官方支援與 benchmark 僅支持試驗，不代表現有 Windows 筆電已達會議可用性。

專案現況以 2026-10-22 文件為準：目前為 WhisperLive（非 WhisperLiveKit）＋faster-whisper／distil-large-v3，以及 OPUS-MT／CTranslate2 CPU int8＋OpenCC s2twp／TSV（非 Argos）。使用者回報速度／品質不可用，音訊到字幕的端到端驗收仍缺。見 [OFFLINE_STT](../OFFLINE_STT.md)、[OFFLINE_TRANSLATION](../OFFLINE_TRANSLATION.md)。

## 候選與排除理由

| 模型／發布日期                                                                                                                                                                                      | 類型、語言與串流性                                                                                               | 參數／模型授權                                                                  | 對本專案的判斷                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Nemotron Speech Streaming EN 0.6B](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)；初版 2026-01-05、更新 03-13                                                                   | 英語音→英語文字；cache-aware FastConformer-RNNT 原生串流；80／160／560／1120ms chunks，含標點                    | 600M；HF 卡列 NVIDIA Open Model License                                         | 英文 ASR 首選實驗，需另接 MT。chunk 設定不是使用者看見穩定字幕的總延遲。                                                    |
| [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)；2026-06-04                                                                                        | 同語轉寫、原生串流；40 locales 分層，32 種即用、8 種需適應訓練；中文為 zh-CN broad-coverage，沒有 zh-TW          | 600M；OpenMDW-1.1                                                               | 可比較中英來源；純英文官方仍推薦 English 專用版。target_lang 是辨識語言條件，**不是翻譯目標**；沒有台灣口音／句內混語保證。 |
| [Riva Translate 4B Instruct v2](https://huggingface.co/nvidia/Riva-Translate-4B-Instruct-v2)；[API 發布 2026-07-27](https://docs.api.nvidia.com/nim/reference/nvidia-riva-translate-4b-instruct-v2) | 文字 MT；37 語言，官方 system tag **en-zh-tw** 明確為英文→繁中；句／文件級自回歸生成                             | 約 4B；NVIDIA Open Model License，卡另列 Apache 2.0                             | **MT 最優先**。已有英→繁中公開評測；不能外推台灣會議術語、殘句與低延遲品質。非語音模型。                                    |
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)；2025-08-14                                                                                                              | ASR，25 歐洲語言、無中文、無 MT。NeMo 提供 buffered streaming；C++ runtime 此模型僅 full-utterance，拒絕串流請求 | 600M；CC BY 4.0                                                                 | 可作英文離線 ASR 對照，低延遲主線優先度低於 cache-aware Nemotron。                                                          |
| [Canary 1B v2](https://huggingface.co/nvidia/canary-1b-v2)；2025-08-14                                                                                                                              | ASR＋speech translation，英語↔24 個歐洲語言，**不含中文**；批次／錄音型用途                                      | 978M；CC BY 4.0                                                                 | 排除英→繁中直譯；不能因名稱含 translation 就採用。                                                                          |
| [Parakeet CTC 0.6B zh-TW](https://build.nvidia.com/nvidia/parakeet-ctc-0_6b-zh-tw/modelcard)；2025-10-09                                                                                            | 台灣華語／英語轉寫；約 90 小時台灣華語訓練，原模型不直接產生標點；Riva 可串流，但不是 cache-aware Nemotron       | 600M；官方頁稱可商用，該頁授權欄未列完整條款，採用前須核對下載 artifact         | **不是英語→繁中翻譯**。Riva／Linux 為所列部署，不與英文 TDT 模型混同。                                                      |
| [Nemotron 3.5 Transcribe 30B-A4B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B)；2026-10-28                                                                                 | 音訊＋文字→文字；支援英語音→中文；官方明示為離線錄音模型，內部 30 秒 chunk **不是串流承諾**                      | **34B total／4.3B active**（含音訊 encoder）；OpenMDW-1.1；列示部署 1×H100 80GB | 適合會後補處理研究，不是筆電小模型即時主線。中文翻譯評測不保證繁中／台灣品質。                                              |
| [Nemotron Nano 4B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16)；2026-03-16                                                                                                        | 文字→文字，官方明列英文／程式語言用途                                                                            | 3.97B；NVIDIA Nemotron Open Model License                                       | 不因訓練資料含中文就宣稱支援英→繁中 MT。                                                                                    |
| [Nemotron 3.5 Bolt E4B 4GB](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB)；2026-10-23                                                                                             | Gemma 4 後訓練文字模型，含中文訓練資料；用途為本機助理／工具操作，非語音辨識                                     | **8B total／4B effective**；Q4_K_M；OpenMDW-1.1                                 | 可作次要文字 MT 對照，但官方無本任務翻譯品質證據。「4GB」名稱不能直接當全部執行記憶體上限。                                 |

TTS（例如 Magpie）是文字→語音，本次字幕需求不需要導入。不要將 ASR、speech translation、文字 MT、TTS 混成同一能力。

## Windows、資源與供應鏈

- [NeMo-Speech.cpp 官方 repository](https://github.com/NVIDIA/NeMo-Speech.cpp) 提供 Windows 安裝、原生 runtime、本機 realtime WebSocket ASR 與 Riva v2 MT；NVIDIA 程式碼為 Apache 2.0，模型授權另計。其 [ASR 指南](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/asr/models.md) 明確區分 cache-aware Nemotron 與只支援整句推論的 Parakeet TDT。
- [官方 ASR benchmark](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/BENCHMARK.md)：i7-11700K、8 threads、LibriSpeech clean 子集、Q8，160ms chunk 平均計算 27ms。測試環境為 Ubuntu，不能外推本機 Windows、會議噪音、MT 共用資源或端到端延遲。
- Riva v2 [官方轉換指南](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/nmt/models.md) 支援 F16／Q8_0 CPU 與 GPU。原 [BF16 權重](https://huggingface.co/nvidia/Riva-Translate-4B-Instruct-v2/tree/main) 約 8.36GB；Q8 約 4～5GB僅為權重估算，**非已驗 VRAM 門檻**。需額外容納 runtime、ASR、工作區與 KV cache。[官方 NMT 設定](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/nmt/configuration.md) 列每個 1024-token decode context 約 136MiB KV；並指出句／短段適合，遠長於此的輸入會劣化。
- [Riva Translate 1.6B](https://build.nvidia.com/nvidia/riva-translate-1_6b/modelcard) 支援 any-to-any zh-TW，但其 [NIM 支援矩陣](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/nmt.html) 要求 Compute Capability ≥8、GPU ≥16GB VRAM、Linux、不支援 WSL；profile 用量約 9.5GB不等於最低硬體要求。[舊獨立容器](https://catalog.ngc.nvidia.com/orgs/nim/nvidia/containers/riva-translate-1_6b/-) 已標 End of Support。它不如原生 Riva v2 路線適合作新實驗入口。
- NVIDIA 模型不是 Qwen／DeepSeek 核心權重的代名詞。不過 Nano／Bolt 官方卡揭露使用相關模型產生合成資料；應透明記錄。現有「禁止部署中國來源核心模型／API」不自動等於禁止所有使用相關合成資料的 NVIDIA 模型，不能擅自擴張禁令。任何採用均須固定確切 checkpoint、授權與第三方 notice。
- Riva v2 可直接輸出 zh-TW，不代表台灣慣用詞、專有名詞與數字正確。仍需保留詞彙 hook；原始輸出與 OpenCC／術語後處理應分開評分。

## 最小評測與採用門檻

1. **先隔離 MT。** 固定同一份人工英文稿與現有 ASR final segments，比 OPUS-MT 與 Riva v2 F16／Q8。語料涵蓋數字、否定、條件、專有名詞、斷句、長短句。人工盲評錯譯、漏譯、幻覺、台灣用詞；記錄 p50／p95／最慢翻譯時間、排隊與尖峰 RAM／VRAM。不要只用通順程度判定勝出。
2. **再隔離 ASR。** 相同真實會議音訊重播，比 distil-large-v3 與 Nemotron English 160／560ms。記錄 WER、數字／實體錯誤、first partial、穩定 final、尾段漏字與靜音幻覺；中英混語另比 3.5，不以純英結果外推。
3. **最後驗組合。** 先讓原 ASR 接 Riva，確立 MT 收益後再測 Nemotron→Riva。MT 獨立 process／有界 queue，只處理 semi-final／final；逾時／crash 保留英文與可見失敗狀態。驗 Stop／restart、斷網與 30～60 分鐘 backlog／記憶體、資源競爭。輸出一律轉成既有 normalized contracts，MT 不得阻塞字幕路徑。
4. **離線與重現。** 預先下載並固定 revision，切斷外網執行；保留原始結果與後處理結果。只有實測確認品質改善、尾延遲／排隊可接受、失敗隔離與長測無回歸，才考慮配置為可用 provider。

目前只有官方資料可行性證據，尚無本機模型、Windows runtime、台灣繁中品質或會議長測結果；本報告不構成採用、取代或完成宣告。

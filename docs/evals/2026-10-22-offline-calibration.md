# 離線能力校準、MT 缺陷修正與 Granite 調研 — 2026-10-22

## 結論與範圍

現有離線實作不能視為已可用的會議字幕方案。使用者回報速度與品質不合需求；本輪找出並修正一個可重現的 MT 輸入缺陷，但未完成音訊端到端、代表性品質或長會議驗收。Granite Speech 5.0 2B 仍為英→中直接語音翻譯的待實測候選，未接入產品。

本輪只改 MT 的 source EOS 與錯誤的逾時註解、增加兩個回歸案例、校準相關文件。沒有安裝依賴、下載模型權重、呼叫付費 API、啟停日常服務或改變產品預設／驗收門檻。

## 前次判斷失準與校準依據

- 「有程式路徑」只能證明實作存在。前次以此描述離線能力，沒有先對照使用者負面回饋與既有失敗證據。
- 10/6 的 `local-mt.json` 已有中→英嚴重重複，`mt-timeout.json` 已證明逾時無法釋放執行中的 worker；10/12 診斷仍列未修。舊 PROJECT_STATE 的 production-ready 敘述與此矛盾，本輪明確撤回該現況宣稱，保留歷史實作紀錄。
- 對負面結論也必須精確：舊英→中單句約 0.232 秒且合理，不支持「所有 MT 推論都慢」。本輪將模型輸出缺陷、模型輸入錯誤、分段等待、排隊與服務不可用分開，不把任一項冒充整體根因。
- 新規則或文件不構成行為已改善的證據。本輪可驗證的強化是補齊模型輸入契約、紅綠回歸、真模型前後對照，以及撤回錯誤的可用性敘述；未宣稱已消除後續判斷失準。

## 直接證據與修正

### 1. Marian 輸入缺少句尾符號

實際路徑為 WhisperLive（`whisper_live.server`，非 WhisperLiveKit）／faster-whisper → SegmentStabilizer → OPUS-MT／CTranslate2 → OpenCC／術語處理。`translation.py` 以 `SentencePiece.EncodeAsPieces()` 產生詞元；兩個本機 CT2 config 都是 `add_source_eos:false`，原程式卻沒有補 `</s>`。

[CTranslate2 官方文件](https://opennmt.net/CTranslate2/guides/transformers.html#special-tokens-in-translation) 明確要求：由 Transformers 轉換的模型不會自動補特殊詞元；若不用 Hugging Face tokenizer，呼叫端須自行補齊。只補 source EOS 的 A/B 使用相同模型、相同文字與相同解碼參數，結果如下：

| 合成測例                                | 修前正式 MT                       | 修後正式 MT                                 | 可支持的結論／仍有缺陷                                   |
| --------------------------------------- | --------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| 延後 launch 至 10/30 週五，除非審查完成 | 除非安全審核完成                  | 我們將延遲到10月30日星期五 除非安全審查完成 | 日期與主句恢復，但 launch 未明確譯出，不算完整正確       |
| API 五秒逾時，但麥克風繼續錄音          | API在五秒後超時,                  | API在五秒後超時了 但麥克風不停地錄音        | 原本漏掉的後半句恢復；措辭仍需品質評估                   |
| 我們明天上午九點開會。                  | tomorrow morning／9 a.m. 多次重複 | We're meeting tomorrow at 9:00 a.m.         | 該測例重複消失，不泛化為所有重複問題已修復               |
| policyholder／premium／policy 術語句    | 術語正確但空格較多                | 要保人必須在保單到期前支付保費。            | 既有術語路徑保留；未遮罩的同句仍會漏譯，不宜移除術語處理 |

正式路徑的 6 個英→中合成測例各跑兩次；修後第二輪單句 MT 為 24.313–65.904 ms，第一筆含載入為 216.578 ms。這是本機 CPU int8、文字輸入、低負載量測，不能代表 ASR、分段、排隊、音訊到字幕延遲或代表性品質。未以這 6 句估算整體正確率或延遲服務水準。

回歸測試先確認 en／zh 兩方向都因缺少 source EOS 失敗；修正後保留繁體目標前綴，僅在最後加一次 `</s>`。未改解碼參數、裁字、去重規則或驗收標準。

### 2. 逾時不等於 worker 復原，仍未修復

受控診斷在獨立程序將 caller 等待設為 50 ms：第一個同步工作等待 Event，第二個極短工作亦逾時且未執行；明確釋放第一個工作後，後續工作才完成。程序最後釋放並 shutdown，未留阻塞執行緒。

這符合 [Python Future.cancel 契約](https://docs.python.org/3.12/library/concurrent.futures.html#concurrent.futures.Future.cancel)。它證明 `wait_for` 不能終止執行中的 thread，不證明這次出現真實 CT2 deadlock，也不證明它就是使用者體感慢的原因。產品註解已更正；worker 可終止性與失敗明示仍待處理，不因本次 EOS 修正結案。

### 3. 慢的來源尚未完成定位

`ASRSession` 先送原文、再把可翻譯段放入容量 10 的非阻塞佇列；滿載會丟最舊待譯段。`SegmentStabilizer` 等 WHL completed，或在後續 feed 發現 partial age 超過 12 秒才強制定稿。這些機制可能增加等待或造成缺譯，但目前沒有同一段真實音訊的跨層時間資料，不能指定其中一項為已證實瓶頸，也未調低門檻求快。

指定 deve 環境未安裝 `whisper-live`、`pyaudiowpatch`、Torch、Transformers。啟動腳本另有專案 `.venv` 選擇邏輯；本輪沒有執行其他 Python，也不把 deve 的套件結果推論為所有啟動方式都不可用。`eval_audio/` 目前只有 README 與文字稿，沒有可執行的 WAV 測資。

## 替代方案調研與用途邊界

| 候選                          | 可調研的用途                                         | 採用前缺口                                                                                         |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Granite Speech 5.0 2B         | 離線英文音訊直接產生中文文字，減少獨立文字 MT 的需求 | 官方英→中支援不等於品質已驗；無本機持續翻譯／固定延遲證據。不能直接代換 `WHL_MODEL` 或文字 MT 函式 |
| Granite 5.0 TurboCTC          | 英文串流轉寫候選                                     | ASR 示範不證明中文翻譯；仍須另一個已驗證 MT                                                        |
| Voxtral Mini 4B Realtime 2602 | 官方明列英／中等語言與原生串流的 ASR 候選            | 此模型定位為轉寫，不能當成英→中 AST；8 GB 筆電的實際記憶體、量化與 Windows runtime 尚未驗          |
| Voxtral 3                     | 最新 ASR／自架能力線索                               | 官方目前宣告 API／自架；不能從舊模型 Apache 2.0 推論新系列公開權重、授權或本機相容性               |

Granite 查核採模型 revision `f4e68169fa2a5751acc4b5da9957855e5e8fc3f1`，已保存模型卡與評測圖的 URL／SHA-256。模型卡日期為 10/20，公告為 10/21；可輸出中文不代表支援中文 ASR、繁體台灣用語或中文語音輸出。**官方英→X FLEURS 圖特別註明 5.0 2B 的 en→zh 未評測。**

本機為 RTX 5060 Laptop、8151 MiB VRAM。它只是候選實驗硬體，不構成可容納模型、穩定延遲或與 STT 併行的證據。Windows 初步優先評估 Transformers 品質基準，再比較 llama.cpp Q8_0；[vLLM 官方](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/#requirements) 不支援原生 Windows，不增加 WSL 作本輪前置。

來源：[IBM 公告](https://huggingface.co/blog/ibm-granite/granite-speech-5)、[Granite 固定版本模型卡](https://huggingface.co/ibm-granite/granite-speech-5.0-2b/blob/f4e68169fa2a5751acc4b5da9957855e5e8fc3f1/README.md)、[固定版本翻譯圖](https://huggingface.co/ibm-granite/granite-speech-5.0-2b/resolve/f4e68169fa2a5751acc4b5da9957855e5e8fc3f1/assets/granite-speech-5.0-2b-bleu-en-x.png)、[Voxtral 2602 模型卡](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602)、[Voxtral 3 公告](https://mistral.ai/news/voxtral-3/)。

## 下一步與採用條件

### 語音處理再校準：新增證據優先於前輪結論

以下為同日進一步唯讀追蹤與受控重播；沒有再改模型、參數或產品程式。前輪 EOS 改善仍成立，但不是整體根因或修復完成證據。

**執行環境／裝置：不能以 deve 代表啟動入口。** `start.bat` 預設優先選專案 `.venv`；該目錄實際有 WhisperLive 0.8.0、faster-whisper 1.2.0、CT2 4.7.1 與 PyAudioWPatch。`torch/version.py` 為 `2.4.1+cpu`、`cuda=None`；torchaudio 為 `2.11.0+cpu`。已安裝 WhisperLive 的 backend 用 `torch.cuda.is_available()` 選擇傳給 CT2 的裝置，否則選 CPU int8。因此，**若實際啟動確實使用這份環境且成功載入，現有裝置選擇會走 CPU，並不會因主機有 RTX 5060 就自動用 GPU。** 尚未執行該環境、驗證套件相容性或辨識音訊，不能把這個條件性推論報成實際會議的 GPU／CPU 執行紀錄；Torch／torchaudio 版本不同亦須檢驗，不能直接宣稱啟動失敗。

**定稿與修訂：已確認一條會改變語意的中間層缺陷，未修。** 直接重播真實 `SegmentStabilizer` 類別，僅控制 monotonic 時間與上游輸入：

| 時間  | 相同 start 的上游文字                         | adapter 輸出                         |
| ----- | --------------------------------------------- | ------------------------------------ |
| 0 秒  | `We should approve the claim.`，partial       | 同文 partial                         |
| 13 秒 | 同文，仍未 completed                          | 強制 final，送 MT                    |
| 14 秒 | `We should not approve the claim.`，completed | 新 final 僅為 `aim.`；舊肯定句未更正 |

原因是定稿後以舊 `emitted_chars` 長度截取新文字，不驗證前綴是否仍相同，也不修訂舊 final。這證明 adapter 可以吞掉否定修訂，不能歸咎於翻譯模型；也不證明該輸入在真實 ASR 的發生頻率。先前把這層簡稱為「穩定原文段落」仍說得太滿：它是有強制定稿及修訂遺失風險的切片器。時間戳亦沿用原段範圍，不是每個切片的精確音訊對齊。

**VAD 與即時性：500 ms 靜音不是定稿期限。** 已讀取實際安裝的 WhisperLive 程式，確認 VAD 參數確有傳入；但 `completed` 還依賴解碼 segment 與相同輸出累計等邏輯（server 預設 threshold 10）。本地 12 秒強制定稿又是在下一次 feed 才檢查，沒有獨立到期輸出。不能由 500 ms、12 秒或單次 MT 耗時推出固定端到端延遲，也不能把這些重疊機制直接相加。檔案 RTF 小於 1 僅是吞吐線索，不代表直播字幕等待短或持續處理不積壓。

**既有評測工具：不能直接用來選本任務的模型。** `compare_models.py` 固定 `language="zh"`，測的是中文／混語轉寫，不是英文語音→中文翻譯；直接使用未斷詞的 `jiwer.wer` 不能當作可靠中文詞錯誤率。逐檔 WER 算術平均是檔案等權指標，也不是全語料詞數加權錯誤率。它使用 `torch.cuda.max_memory_allocated()` 報 CT2 的 VRAM；[PyTorch 官方](https://docs.pytorch.org/docs/2.14/torch_cuda_memory.html#identifying-non-pytorch-allocations) 明列 allocator 統計看不到外部 CUDA 分配，所以該數字不能當 CT2 總用量。應先校正量測方法，再解讀排名；本輪未修改或執行此工具。

**模型比較須同任務。** 此次用途是英文語音→台灣繁體中文字幕：distil-large-v3 的英文定位本身不是不適配證據，Granite 未列中文 ASR 也不構成此單向用途的否決理由。Voxtral 的中文 ASR 支援則不是英→中翻譯優勢。選型仍應比較同一音訊、同一中文語意要求、同一延遲／資源限制下的整條路徑，不能以不同榜單互相代換。

建議後續依序固定實際 launcher/runtime/device，修正否定等修訂的保存語意，再使用同批有人工稿的音訊分別驗證 ASR、人工原文→MT、ASR 輸出→MT 與直接 AST。延遲需同時量第一筆可讀譯文與穩定譯文，相對到對應語音區間；品質需單列否定、數字、日期、條件與資訊遺失，不只計字數、WER 或「有輸出」。目前沒有足以選定替代模型或宣稱整體已掌握根因的證據。

證據：`.cache/offline-calibration-20261022/stabilizer-revision.json` 保存輸入／輸出與相關來源雜湊。獨立判讀複核確認上述推論界限。`pnpm service:status` 當時回報 managed `phase:stopped`，只代表該入口，未推論其他啟動方式／程序不存在。

沿用 N3/N4 與 L2，不另開平行產品架構；線上主線優先順序不變。

1. 對實際離線啟動方式核對 runtime、依賴、模型版本與可辨識音訊；無法啟動就明示不可用。
2. 用有權使用、具人工原稿與中文參考譯文的英文會議音訊，先定義可接受等待與品質門檻。固定數字、日期、否定、條件、專名與刻意重複，不以少數合成句代替代表性樣本。
3. 若續作 Granite，先獨立跑同一批音訊。記錄音訊起訖、VAD／定稿、排隊、推論與顯示時間；冷／暖啟動、漏譯、錯譯、重複、幻覺、RAM／VRAM 分開記錄。原生串流與分段推論分開命名。
4. 只有品質與等待均達門檻，才接 normalized events、英文原稿關聯、失敗降級與全量保存；不能假造 sourceText，或以中譯事件有輸出就算整合完成。持續輸入另驗佇列不累積、Stop 能回收及故障後恢復。

## 驗證與重現

- `deve python -m pytest tests/test_translation.py -k marian_source -q -p no:cacheprovider`：修前 2 failed（缺 `</s>`）。
- 同檔完整修後 16 passed；`deve python -m pytest tests -q -p no:cacheprovider`：87 passed。各有既存 SWIG deprecation warnings。
- 指定 Python 的 `-m ruff check`：無法執行，環境未安裝 Ruff；未安裝套件或改用其他 runtime。
- 六份本輪文件的 Prettier 檢查通過。初輪遇到新增行與既有 CRLF 混用，依專案 LF 設定正規化後通過，未重排其他內容。
- 獨立唯讀審查核對兩方向模型 config、程式差異、測試及推論來源雜湊，未發現此次 EOS 修正的阻擋問題；未據此擴張為離線整體驗收。
- `.cache/offline-calibration-20261022/` 保存 `probe.py`、`infer.json`（修前）、`eos.json`（單變因）、`infer-after.json`（修後）、`timeout.json`／`timeout-after.json`（受控機制修前／修後皆未復原）、紅綠與回歸日誌、來源／模型檔雜湊及官方資料快照。兩份 after 紀錄的來源／模型檔雜湊已與最後狀態核對一致。`.cache` 為本機證據，不列入產品交付。

PowerShell 重現修後文字測例（不下載模型）：

```powershell
& 'C:\Programs\miniforge3\envs\deve\python.exe' '.cache/offline-calibration-20261022/probe.py' infer replay
```

此命令只驗文字 MT；完整離線音訊、真人品質、持續串流、固定延遲與長會議仍未驗收。沒有以本輪結果宣稱整套離線方案修好。

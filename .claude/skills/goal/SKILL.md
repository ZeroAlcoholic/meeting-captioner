---
name: goal
description: finish T0–T5 as a senior engineer, no technical debt — clean code, SOLID, review then report
disable-model-invocation: true
allowed-tools: Bash(pnpm *) Bash(node *) Bash(npx *) Bash(git status *) Bash(git diff *)
---

**GOAL** finish T0 T1 T2 T3 T4 T5 as a senior software engineer, without technical debt.
一次做完，不分批、不徵詢。以下為整輪標準，不是一次性步驟。

**[SPEC]** @docs/evals/2026-10-09-followup-diagnosis.md — 任務與驗收以該文件「三、任務序」為準，只做 T0–T5。

**[CODE]** clean code、SOLID；沒有第二個使用者就不加抽象層；風格、命名、註解密度比照周邊程式碼；不留死碼。

**[PROOF]** 先紅後綠，沒紅過不算完成；熱路徑改動附實測數字；合成音訊只證管線、永不證辨識品質。

**[HOLD]** 不動斷句門檻預設值；不 commit、不切分支；Python 走 `/c/Programs/miniforge3/envs/deve/python.exe`；台灣繁體用詞。單項卡住，其餘照常做完。

**[DONE]** review then report —
`pnpm -r test`／`typecheck`／`lint`／`format:check` 全綠 → `/code-review` 對 `[CODE]` 逐條核 → 一輪證偽（測試真的紅過？預設行為真的沒變？數字真的量過？）→ 更新 `PROJECT_STATE.md`／`TODO.md` → 一次回報：改了什麼｜檔案｜怎麼跑｜數字｜**還沒驗證什麼**｜複查與證偽所得｜範圍外發現（只列不動手）。

# 交接：手機網頁版（2026-11-10）

## 一句話

線上版新增一個免伺服器的手機網頁，已上線：
**https://zeroalcoholic.github.io/meeting-captioner/**

手機開網址 → 貼上自己的 Gemini（或 OpenAI）金鑰 → 開始，即時顯示翻譯字幕。

## 使用者定案的方向（不要推翻）

- 主機：GitHub Pages，共用現有 repo `ZeroAlcoholic/meeting-captioner` 的 `gh-pages` 分支。
- 金鑰：使用者在手機上分別輸入 Gemini／OpenAI，只存該裝置瀏覽器。這是「金鑰只在伺服器端」的限定例外，只適用手機版（`DECISIONS.md` D21、`CLAUDE.md` Security 段）。
- 產品：輕量、逐字易讀、固定深色底、不存稿、Gemini 優先。
- 因此手機版**不做**：SQLite／存檔、純字幕模式、系統音訊、淺色主題、兩家自動接管。

## 怎麼運作

線上後端原本只做兩件事：用金鑰換短效連線憑證、把逐字稿存 SQLite。手機版把第一件搬進瀏覽器，第二件不做。

| 檔案                                              | 作用                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/mobile.html`                            | 手機頁面入口                                                                                                                  |
| `apps/web/src/mobile/main.tsx`                    | 啟動時安裝瀏覽器內 broker                                                                                                     |
| `apps/web/src/mobile/device-broker.ts`            | 在瀏覽器直接向 Gemini／OpenAI 取短效憑證；回應格式與 `services/online` 的 `/session`、`/session/gemini`、`/session/info` 相同 |
| `apps/web/src/mobile/device-keys.ts`              | 金鑰存取（localStorage，只顯示末四碼）                                                                                        |
| `apps/web/src/mobile/MobileApp.tsx`、`mobile.css` | 畫面：字幕閱讀區、開始／停止、設定與金鑰管理                                                                                  |
| `apps/web/src/mobile/device-broker.test.ts`       | 15 項單元測試                                                                                                                 |
| `apps/web/src/providers/service-fetch.ts`         | 「向服務取憑證」的唯一接縫；預設走網路，手機版換成 broker                                                                     |
| `apps/web/vite.mobile.config.ts`                  | 手機版建置設定（相對路徑、輸出 `dist-mobile/`）                                                                               |
| `apps/web/public/mobile.webmanifest`、`icon.svg`  | 加入主畫面用                                                                                                                  |

對既有程式的改動只有四處，桌面行為不變：

- `gemini-live-provider.ts`、`openai-realtime-provider.ts`、`session-info-polling.ts`：取憑證的 `fetch` 改成 `serviceFetch`。
- `audio-engine.ts`：worklet 路徑改用建置 base（手機版在子路徑下）。

另外：`eslint.config.js` 與 `.gitignore` 加入 `dist-mobile`；`apps/web/package.json` 加 `build:mobile`、`dev:mobile`；`tsconfig.node.json` 納入新設定檔。

## 指令

```
pnpm -F web dev:mobile      # 開發
pnpm -F web build:mobile    # 建置 → apps/web/dist-mobile/
pnpm -F web exec vitest run src/mobile
```

## 更新線上網站

1. `pnpm -F web build:mobile`
2. 把 `apps/web/dist-mobile/` 的內容加上空的 `.nojekyll`，做成 `gh-pages` 分支的新提交。這次的做法：複製到暫存資料夾 `git init -b gh-pages` 提交，再 `git fetch <暫存路徑> +gh-pages:gh-pages` 帶回本 repo。
3. `git push origin gh-pages` —— **必須由使用者執行**。使用者全域設定 `~/.claude/settings.json` 禁止代理執行 `git push`、`curl`、`rm`，不要嘗試繞過。

目前線上版本：`gh-pages` 提交 `e82de7a`，主程式 `assets/mobile-CvGu26D5.js`。

## 已驗證

- 全專案單元：web 976、contracts 37、online 211、架構邊界 3，全過；之後新增 1 項，手機模組 15 項另跑通過。
- typecheck、`pnpm lint`、`build:online`、`build:mobile` 通過；手機主程式 gzip 約 103 KB。
- Chrome 手機尺寸（390×844、360×640）實測：首次輸入金鑰、字幕閱讀（模擬資料）、設定面板、無水平捲動、往上閱讀時新字幕不搶捲動。
- 假金鑰實測：瀏覽器可直接連到 Google 取憑證端點，顯示「金鑰被拒絕」；按開始後以白話訊息停下並可重試；頁面內容不含完整金鑰。
- 線上網址實測：HTTPS 200、載入最終建置、靜態資源正常、無頁面錯誤。

## 尚未驗證（下一步優先）

1. 真金鑰的端到端字幕（Gemini 優先）。
2. 實體 iPhone／Android：麥克風、螢幕恆亮、切到背景再回來。
3. OpenAI 取憑證端點是否允許瀏覽器直接呼叫（只確認了 Gemini）。

## 已知限制

- 只支援麥克風；螢幕關閉或切到背景會停止收音。
- 字幕只在記憶體，關閉分頁即清除；可「複製全文／分享」。
- 有 IP 白名單的公司 OpenAI 金鑰在行動網路會被拒絕。
- 主畫面圖示只有 SVG，iPhone 可能改用頁面截圖。

## 未完成的事

- **原始碼尚未提交**：上述新檔與改動都還在工作目錄；分支 `docs/goal-phase-2` 上另有先前累積的大量未提交變更，這次沒有動。
- 沒有自動部署；若要「推到 main 就發佈」，可加 GitHub Actions 工作流程（參考 eng-coach 的 `pages.yml`），並把 Pages 來源改成 workflow。
- `.playwright-mcp/` 內有這次的驗證截圖（`m1`–`m7`），可刪。

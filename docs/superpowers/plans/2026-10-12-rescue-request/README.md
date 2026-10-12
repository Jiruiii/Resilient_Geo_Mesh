# 需要救援／求救點 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「需要救援」求救事件（`crowd.rescue`／`RESCUE_REQUEST`）的完整生命週期、Web 與 Android 雙端送出與顯示，以及本機定位警報聲。

**Architecture:** 求救事件沿用 event-v0 與裝置 Ed25519 自我證明簽章。JS（pipeline）、Kotlin（Android）、瀏覽器 JS（Web）三端各自產生位元相同的事件，由共用 fixture 鎖定。Android 走 Room＋mesh，Web 走 WebCrypto＋IndexedDB outbox＋server 原樣轉發；Android 有網路時也與 server 上下行。Flutter 共用層只做 UI、狀態呈現與 siren 抽象，平台實作分別在 Kotlin 與 `flutter/web/*.js`。

**Tech Stack:** Node 22（`node:test`、Fastify）、Kotlin＋Room＋Bouncy Castle、Flutter 3（Dart、`dart:js_interop`）、WebCrypto Ed25519、Web Audio、Android MediaPlayer＋mediaPlayback 前景服務、Azure Bicep。

**Spec:** [`docs/superpowers/specs/2026-10-12-rescue-request-design.md`](../../specs/2026-10-12-rescue-request-design.md)

## Global Constraints

- namespace `crowd.rescue`；event_type `RESCUE_REQUEST`；source `CROWD`；source_version `rescue-request-v0`。
- event_id 格式 `rescue:<32 hex 指紋>:<小寫 UUID>`，指紋必須等於 `signing_key_id` 去掉 `device:`。
- dataset `crowd-rescue`；manifest id `crowd-rescue:none`；chunk_id `crowd-rescue:<event_id>`；chunk theme `rescue`、area_id `crowd`。
- request_type：`FIRST_AID_NEEDED`、`IMMOBILE`、`TRAPPED`、`TRAPPED_DEBRIS`、`OTHER_RESCUE`。
- status：`ACTIVE`、`RESOLVED`、`CANCELLED`。
- subject：`SELF`、`OTHERS`；`SELF` 時 `triage.conscious` 必須是 `YES`。
- triage 欄位：`immobile`、`breathing_difficulty`、`severe_bleeding`、`conscious`，值 `YES`／`NO`／`UNKNOWN`。
- urgency（`severity`）推導：`TRAPPED_DEBRIS` → CRITICAL；呼吸困難／大量出血 = YES 或清醒 = NO → CRITICAL；`TRAPPED`／`IMMOBILE` 或 immobile = YES → HIGH；其他 → MEDIUM。人數不影響。求救沒有 LOW。
- people_count 整數 1–50；description trim 後 ≤ 160 code points；location_hint 格式同 crowd report。
- attributes 只允許：`request_type`、`status`、`subject`、`people_count`、`triage`、`description`、`location_source`、`location_hint`、`first_issued_at`、`area_id`、`theme`。
- TTL 6 小時；延長後 `expires_at = min(now + 6h, first_issued_at + 72h)`；`0 < expires_at - issued_at ≤ 6h`；`expires_at ≤ first_issued_at + 72h`；`first_issued_at ≤ issued_at`；v1 時 `first_issued_at == issued_at`。
- 終態（RESOLVED／CANCELLED）沿用前一版 `expires_at`；終態後不接受任何新版本；`first_issued_at` 不可變；`event_version ≤ 200`。
- 任何 `crowd.*` 事件的新版本必須由同一 `signing_key_id` 簽署。
- 驗證階段順序：schema → trust → integrity → signature → contract（`crowd.rescue` 專屬檢查，錯誤 stage 為 `contract`）。
- 每台裝置同時最多 1 筆 ACTIVE 求救；本機修訂冷卻 30 秒。
- Mesh：他人求救最多保留 300 筆。
- 上傳、儲存、下載與 mesh 轉傳的單位都是「原裝置簽章的 crowd-rescue chunk」；server 與中繼節點都不重簽、不改寫。
- Server：POST body ≤ 8192 bytes；每 key 每 60 秒 ≤ 3 次寫入；每 IP 每 10 分鐘 ≤ 20 次寫入；`issued_at` 超前 server 時間 > 5 分鐘拒收；GET bbox 每邊 ≤ 0.05 度；blob 最後修改 7 天後刪除。
- Siren：只在使用者點擊後播放；每次 60 秒自動停止；約 3 kHz 三短聲（0.4 秒聲、0.3 秒間隔、每輪後 1.5 秒靜音）；不調整系統音量；Android 用 `USAGE_ALARM`。
- 固定文案：
  - 「此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。」
  - 「未經查證，不代表已派遣救援」
  - 「此功能不能取代 119，請在可撥打時優先撥打 119」
  - 「請勿輸入姓名、電話、身分證號等非必要個資；描述會公開給收到求救的人」
- 不新增 Flutter pubspec 依賴；Android 只新增權限 `FOREGROUND_SERVICE_MEDIA_PLAYBACK`、`WAKE_LOCK`。
- 不在 log、錯誤訊息或 HTTP 回應中輸出描述與座標。
- 既有 `crowd.reports` 格式、fixture、TTL 不變。
- 開發位置：`D:\桌面\OSS`，分支 `feat/rescue-request`。只在此分支 commit；**每完成一冊（01–07）並通過該冊驗收後，commit 一次**（不逐任務 commit），commit 前需向使用者取得明確同意；push 與 PR 另外需使用者確認。不要動未追蹤的 `.pub-cache/`。

## 分冊與任務

| 分冊 | 任務 |
|---|---|
| [01 共用契約（pipeline）](01-contract-pipeline.md) | 1 契約驗證器 · 2 事件與修訂建構器 · 3 通用 crowd chunk 與套用規則 · 4 共用 fixture |
| [02 Android 資料層](02-android-data.md) | 5 Kotlin 契約與套用規則 · 6 Kotlin 建構器與 chunk · 7 Repository · 8 Bridge · 9 路線排除 |
| [03 Server 與 Azure](03-server.md) | 10 速率限制 · 11 求救儲存 · 12 路由 · 13 組裝與設定 · 14 部署 |
| [04 Web 送出](04-web-outbox.md) | 15 `rescue_outbox.js` · 16 Dart 共用模型與 `RescueService` |
| [05 Flutter UI](05-flutter-ui.md) | 17 既有邏輯調整 · 18 地圖 marker 與 cluster · 19 詳情 · 20 表單 · 21 流程控制與狀態卡 · 22 首頁整合 |
| [06 定位警報](06-siren.md) | 23 音檔 · 24 Android 服務 · 25 Web 播放 · 26 Flutter 控制、面板與整合 |
| [07 線上同步、文件與交付](07-sync-docs-delivery.md) | 27 Android 線上同步 · 28 文件 · 29 完整驗證與交付 |

依序執行，但**不逐任務 commit**——每完成一冊才 commit 一次（見下方「指令速查」後的說明）。每個任務的 **Interfaces** 區塊列出它依賴與提供的名稱與型別；跨分冊的名稱以那裡為準。

## 指令速查（皆在 `D:\桌面\OSS` 執行）

| 用途 | 指令 |
|---|---|
| Node 單檔測試 | `node --test pipeline/test/<file>.test.mjs` |
| Node 全部 | `node --test pipeline/test server/test` |
| Kotlin JVM 測試 | `cd android; .\gradlew.bat testDebugUnitTest --tests "<FQCN>"` |
| Android 儀器測試 | `cd android; .\gradlew.bat connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=<FQCN>"` |
| Android build | `cd android; .\gradlew.bat assembleDebug` |
| Flutter 單檔 | `cd flutter; flutter test test/<file>_test.dart` |
| Flutter 全部 | `cd flutter; flutter analyze; flutter test` |
| Web build | `cd flutter; flutter build web --release` |

每完成一冊（01–07）並通過該冊驗收後，在 `feat/rescue-request` 分支建立**一次 commit**，內容只涵蓋該冊對應的變更。第一冊（01 共用契約）的 commit 另外加入規格檔 `docs/superpowers/specs/2026-10-12-rescue-request-design.md` 與本計畫目錄。commit 訊息不附署名行。每次 commit 前必須先列出將納入的檔案與摘要，取得使用者明確同意後才可執行 `git commit`。

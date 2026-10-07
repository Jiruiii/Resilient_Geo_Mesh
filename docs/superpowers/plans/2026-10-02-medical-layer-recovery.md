# Medical Layer Recovery Implementation Plan

> **2026-10-03 scope adjustment**

The current approved shelter scope is static shelter locations and planned capacity only. `taiwan-shelter-status` is no longer a required source-status or feed acceptance item; preserve legacy client fixtures and handling without modifying Android/Flutter.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安全重建本機 API／collector，讓 `taiwan-medical` 有本次收集的真實計數與非空、可下載且可驗簽的 layer。

**Architecture:** 以專案根目錄的 Docker ignore 控制 build context；Collector 保留既有完整來源 registry 與排程，只讓部署當次的首次收集可指定來源。醫療配對報告沿著 collector result 傳到現有 source-status publisher；空 layer 仍視為失敗並保留舊 release。

**Tech Stack:** Node.js 22 ESM、`node:test`、Docker Compose、Fastify、現有 Ed25519 feature bundle。

**Spec:** [中央 Server 資料接入設計](../specs/2026-10-02-central-server-data-ingestion-design.md)；驗收依 [中央 Server runbook](../../central-server-runbook.md) 與本次提出的四項要求。

## Global Constraints

- 不修改 Android／Flutter，也不改動既有 private/public Docker volumes 或其他工作樹 WIP。
- CWA、NCDR credentials 與簽章私鑰只能由 collector environment／secret mount 提供；不得進 image、公開 release、log 或文件。
- 本次 live 收集要用實際官方資料；不得用 fixture、舊快取計數或手填零冒充成功。
- 空醫療 layer 不發布；失敗時仍要回報本次有實際完成的計數，未完成的階段不填零。
- 不執行 `git add`、commit、push；不使用 `docker compose down -v` 或全域 image prune。

## Review Focus

- `deploy/.dockerignore` 對 `context: ..` 無效：root `.dockerignore` 必須真的排除巢狀 `pipeline/.env`；以新 image 檔案檢查確認。
- 上游或查詢規劃在配對前失敗：`matched_count` 應缺席，不得拿舊值或假零充數；加 publisher regression test。
- 有候選座標但沒有醫療配對：狀態須顯示本次 `candidate_count > 0`、`matched_count = 0`、`MEDICAL_LAYER_EMPTY`，且不建立新 manifest；加 collector／publisher test。
- 首次只收醫療但其他來源缺 cache：Collector 應明確失敗並保持 current feed；部署前檢查完整 cache，不能把 lock skip／缺 cache 算成功。
- 政府 feed 成功而 layer 發布失敗：驗收須獨立確認 source status、HTTP manifest、所有 chunks 與簽章，不能只看 `/readyz`。

---

### Task 1: 修正 Docker build context 的 secrets 邊界

**Files:**
- Create: `.dockerignore`
- Reference: `deploy/.dockerignore`、`deploy/Dockerfile`、`deploy/docker-compose.yml`
- Test: `server/test/deployment-config.test.mjs`

**Interfaces:** Docker build context 為專案根目錄；`COPY pipeline ./pipeline` 不得帶入 dotenv／私鑰／本機 raw cache。

- [x] 擴充 deployment-config test，檢查 root `.dockerignore` 存在並涵蓋 `.env`、`.env.*`、`**/.env`、`**/.env.*`、私鑰與本機資料目錄；確認 Compose build context 與 Dockerfile COPY 邊界。
- [x] 執行 `node --test server/test/deployment-config.test.mjs`，先確認新測試因 root ignore 缺失而失敗。
- [x] 從既有 `deploy/.dockerignore` 移植完整排除規則到 root `.dockerignore`，補齊巢狀 dotenv 規則；`.env.example` 可保留為無密鑰範例。`deploy/.dockerignore` 只作既有檔案保留，不視為防護。
- [x] 重跑同一測試，確認通過；重建後再以 image 實際檔案檢查兜底。（image 檢查列在 Task 4）

### Task 2: 空醫療 layer 的本次報告可觀測，且不污染成功快取

**Files:**
- Modify: `pipeline/lib/source-collector.mjs` 的醫療分支與 `collectSource` 錯誤回傳
- Modify: `server/src/publisher/release-publisher.mjs` 的 `medicalCoverage`
- Test: `pipeline/test/source-collector.test.mjs`
- Test: `server/test/release-publisher.test.mjs`

**Interfaces:** 醫療 result 新增選用 `coordinateReport`（只含 `source_ids`、`query_count`、`candidate_count`、`matched_count`、`unresolved_count`、`rejected_coordinate_count`）；publisher 只將安全整數與安全 source IDs 映射到公開 status 既有欄位。

- [x] 新增失敗測試：官方候選為空及候選非空但識別資料不配對時，`collectSource` 回傳 `unavailable`／`MEDICAL_LAYER_EMPTY`／`publishable:false`，帶本次 `coordinateReport`，`matched_count=0`，不寫空的 normalized cache。
- [x] 新增 publisher 測試：`MEDICAL_LAYER_EMPTY` 的 status 保留本次真實計數；若本次錯誤發生在產生 report 前，status 不沿用舊的 `matched_count`；成功／`not_modified` 仍保留正確計數。
- [x] 執行 `node --test pipeline/test/source-collector.test.mjs server/test/release-publisher.test.mjs`，確認新測試先失敗。
- [x] 在配對完成後先組裝 report，再依 `features.length` 決定成功或丟 `MEDICAL_LAYER_EMPTY`；只把這份 report 透過錯誤結果傳給 publisher，不把失敗的空 normalized 寫入 last-known-good cache。
- [x] 調整 `medicalCoverage` 優先使用本次 `coordinateReport`；只有成功／快取 `not_modified` 才讀 normalized／previous report。上游提早失敗時省略計數，不顯示舊成功數字。
- [x] 重跑上述 targeted tests，確認通過；既有 `/v1/source-status` route 的安全欄位轉發不需擴充。

### Task 3: 限定部署當次的首次收集來源

**Files:**
- Modify: `server/src/collector-entrypoint.mjs`
- Modify: `deploy/docker-compose.yml`
- Modify: `docs/central-server-runbook.md`
- Test: `server/test/collector-entrypoint.test.mjs`

**Interfaces:** `COLLECTOR_INITIAL_SOURCE_IDS` 為可選、逗號分隔的預設啟用來源 ID；空值維持現有「啟動時收全部預設來源」。只影響 `main()` 的首次 `runOnce({selectedSourceIds})`；之後 scheduler 仍按原 registry 正常排程。此值會留在當前容器設定中，日後重啟該容器仍會套用；後續正常部署不帶此 override 時恢復預設首次收集。

- [x] 新增選來源測試：`taiwan-medical` 只指定該來源首次收集；空值仍選全部預設來源；未知、停用、重複或空 token 明確拒絕。既有 `runOnce` 測試確認其他來源由 cache 組成完整結果集。
- [x] 執行 `node --test server/test/collector-entrypoint.test.mjs`，確認新測試先失敗。
- [x] 在入口點解析並驗證 `COLLECTOR_INITIAL_SOURCE_IDS`，Compose 只轉發此可選變數；入口點記錄不含敏感資料的首次收集摘要，讓 `skipped`／`reason` 可辨。更新 runbook 的部署當次 shell 指定方式、容器重啟行為與 cache 前置條件。
- [x] 重跑 targeted test，確認通過；驗收時明確檢查 `runOnce` 的回傳不是 `lock_held`、`source_failure` 或 `SOURCE_CACHE_MISSING`。一般排程仍可能按週期收其他來源，限定的是本次啟動的首輪收集。

### Task 4: 本機重建、live 收集與雙項驗收

**Files:** 預期以部署驗收為主；live 證據顯示查詢範圍規劃不適用全台灣邊界時，可做最小查詢規劃修正並補回歸測試。

- [x] 記錄可取得的 baseline：API `/readyz` feed revision 66／3 datasets、medical manifest HTTP 404、private cache `feature_count=0` 且無 `coordinate_report`；原 API／collector image IDs 為 `sha256:f6016023da3264b5536afddcb7fddf76929d424f4c85dce247c942d645f697f9`／`sha256:5116878055c0fbb2c9aedb93220863a58727c68afd3e8384be11c8eeffba9514`。舊 medical `checked_at` 未留存在 baseline 紀錄，故不補猜測值。
- [x] 使用 `docker compose --env-file .env -f deploy/docker-compose.yml config --quiet` 檢查設定，不印完整 Compose config。
- [x] 設 `COLLECTOR_INITIAL_SOURCE_IDS=taiwan-medical`，執行 `docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --no-deps api collector`；保留 named volumes。啟動前確認 collector lock 不存在。
- [x] 新 API／collector image IDs 為 `sha256:8737099c0154952a8d53a4b86a2879785257be49c5b1264735ef00cdbecbd21e`／`sha256:a817dc9814152814e453902ba4d9e5814b743b6d50b1039669f3054e8d0ec507`；兩者都含 health-check module，遞迴掃描 `/app` 沒有非範例 dotenv。舊 image 已不在本機 daemon；本機狀態無法判定它過去是否曾推送、匯出或交給他人，若曾外流需輪替 CWA／NCDR keys。
- [x] collector 首輪摘要為 `skipped=false`、medical `partial`；本次 medical `retrieved_at=2026-10-02T15:11:49.841Z`，後續 source status `checked_at=2026-10-02T15:25:17.588Z`，`query_count=368`、`candidate_count=3515`、`matched_count=747`、`unresolved_count=23391`、`rejected_coordinate_count=0`。Feed revision 78 的 status 保留以上實測計數；未以舊 cache 當成新 matched 數。
- [x] 本次 `matched_count=747 > 0`；零匹配診斷分支不適用。`partial` 與 `unresolved_count=23391` 原樣保留並由 health check 提示。
- [x] 透過 HTTP 下載並驗證 medical／shelter manifests 與全部 chunks：醫療 manifest 200、747/747 chunks 200、`total_feature_count=747`、dataset version 1、建立時間 `2026-10-02T15:11:49.841Z`；避難所 manifest 200、2956/2956 chunks 200、`total_feature_count=5907`、version 5。兩個 bundle 的受信任 key ID、hash、Ed25519 簽章與有效期皆通過。
- [x] 歷史驗收執行 `npm run server:health -- --base-url http://127.0.0.1:8787`：`ok=true`、errors 空、`/readyz=ready`、feed revision 78、3 datasets；當時 NCDR、CWA、避難所狀態為 `ok`／`not_modified`，沒有失敗來源。唯一 warning 是 medical `partial`。避難所狀態來源已於 2026-10-03 停止收集。
- [x] 對 private/public volumes 執行隔離目的地 backup → restore → 簽章驗證；backup 與 restored feed revision 76，layers 均包含 `taiwan-medical`、`taiwan-shelter`、`osm-taiwan`，驗證通過後清除本次專用暫存目錄。

實際全台灣 area catalog 為 390 個行政區、368 個 town features。全台 30 km 網格估計需要 2,220 次查詢，超過 500 上限；改為每個 town 選一個去重且在該 town 自身 polygon 內的代表點。代表點保留 full precision，避免窄邊界經六位小數四捨五入後跑到邊界外。`node --test pipeline/test/medical-coordinates.test.mjs` 8/8 通過。

完整回歸：`npm test` 219/219 通過；`npm run test:server` 62/62 通過。所有變更保留在工作樹，未 add／commit／push。

## 完成判準

新 image 無真實 dotenv；本次醫療收集 `matched_count>0` 且報告與 source status 可對應；medical 與靜態 shelter manifest/chunks 可下載並以正確 key 驗簽；`/readyz`、非空 `/feed.json`、NCDR／CWA、health check 及新資料的 backup／restore 均通過。若任一條件失敗，逐項回報實測值與原因，不宣稱最後驗收完成。

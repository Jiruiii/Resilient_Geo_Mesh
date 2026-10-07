# ResilientGeo Central Server Runbook

這份 runbook 說明中央 Server 與同步交付 Web／Android 的部署邊界。Flutter Web 及 Android 已接入簽章 feed、靜態圖層與縣市門牌包，並使用隨 App 提供的 OSM 離線底圖；Server 或用戶端資料契約變更需在同一批次建置及驗收。此 runbook 提供 VPS/Caddy 部署流程；Azure workflow 目前只部署 API 與排程工作，不部署 Flutter Web 靜態檔。

## 部署前準備

在 VPS 建立 private cache 與 public release 的持久化 Docker volumes。準備一組 Ed25519 key pair，private key 只放在 collector 使用的 secret mount；public key 可提供給 API 做 `/readyz` 驗證。設定 `SIGNING_KEY_ID`，並準備不含 credentials 的 `data/area-catalog.json`。

Compose 所需的上游 credentials（`CWA_API_KEY`、`NCDR_ALERT_API_KEY`）以及 `SIGNING_PRIVATE_KEY_FILE`、`SIGNING_PUBLIC_KEY_FILE`、`SERVER_DOMAIN` 由 VPS environment 或 secret manager 提供，不要寫進 Git、image、Raw snapshot 或 log。TDX 目前是 opt-in source，不是預設核心災害 feed；只有手動啟用 TDX 時才需要 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`。

Azure 手動部署 workflow 使用 GitHub secret `GOVERNMENT_SIGNING_PRIVATE_KEY`，在 runner 內推導 public key，並先比對 Flutter 信任清單中的 `government-feed-2026` public key，再寫入 Key Vault。勿建立或記錄明文私鑰輸出。Azure Bicep 預設使用這個 key ID；Compose 範例則使用 `central-server-2026`，部署時需讓 `SIGNING_KEY_ID` 與實際 key pair 一致。

Server 預設收集邊界如下：

- 核心災害 feed：NCDR 全台事件（公開出版排除 `BACKGROUND`）與 CWA 地震、天氣特報、颱風。
- 應變資源：全台靜態避難所位置與醫療院所，各自以獨立 layer 發布。避難所開設狀態不在目前收集範圍。
- 暫停預設收集：TDX 道路事件與 OSM POI。兩者仍保留 adapter 與 registry，日後可明確指定 source 後單獨收集。

## Initial release

在部署中的同一個 checkout 執行以下命令。Web 靜態檔由 Caddy 從 `flutter/build/web` 掛載，不會包含在 Node Server image；每次 Web 程式更新都必須先重新產生該目錄，再重建／啟動 Compose。Caddy 另以唯讀方式提供簽章縣市門牌包；OSM 底圖隨 App 提供，不由 Server 發布。

```bash
flutter build web --release --no-web-resources-cdn --no-pub
test -s flutter/build/web/index.html
docker compose -f deploy/docker-compose.yml config
docker compose -f deploy/docker-compose.yml up -d --build
curl -fsS https://$SERVER_DOMAIN/healthz
curl -fsS https://$SERVER_DOMAIN/readyz
```

Android App 的中央 Server URL 仍由 `android/app/src/main/assets/trust/government-service.json` 設定。正式發佈前須將其 `base_url` 指向實際 HTTPS 網域，並在同一批次驗證 Android 和 Web；本機或 Azure workflow 成功不代表正式網域已完成部署。

collector 會以排程呼叫官方來源、寫入 private source cache，再將已正規化且簽章的 feed/layer 寫入 public release。API request 不會觸發 upstream refresh。第一次成功的 signed feed 發布前，`/readyz` 維持 503 是預期行為。

既有 feed 若含舊版 `shelter-status` dataset，collector 部署後的下一次完整成功發布會從 current feed 移除它；舊 immutable revisions 與 private cache 仍保留作歷史稽核。靜態避難所 layer 仍會照原排程更新。

Collector 的排程會將同時到期的來源排入單一序列佇列，避免來源競爭全域 lock 而被靜默跳過。每次排程會以本次成功結果加上其他來源的 last-known-good cache 組成完整結果集；來源缺少 cache，或狀態為 `partial`／`stale`／`unavailable`／`blocked_by_auth` 時，會保留目前 `current/feed.json`，不發布不完整版本。來源檢查成功且當下沒有有效告警時，零資料集仍可通過 schema、hash、signature 與 chunk 驗證並發布有效的簽章空 feed；來源失敗時則沿用上一個可信版本。發布器完成 staging 與簽章驗證後才切換 current pointer。

要只在重建後的首次 run 收集指定來源，可於 Compose 命令前設定 `COLLECTOR_INITIAL_SOURCE_IDS`。例如先只收醫療：

```bash
COLLECTOR_INITIAL_SOURCE_IDS=taiwan-medical \
  docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --no-deps api collector
```

其他預設來源必須已有可用 cache，Collector 才能組成完整發布結果。首次 run 後 scheduler 仍會照 registry 排程全部預設來源。這個值會留在當前容器設定，該容器重啟時首次 run 仍只收指定來源；下次正常部署不設定此值時，首次 run 會恢復收集全部預設來源。啟動 log 會列出首次 run 的 skip 原因與來源狀態摘要。

Collector lock 位於 private volume，會記錄 PID 啟動識別；容器重建後若 PID 被重新使用，會自動回收舊 lock，避免首輪收集被誤判為 `lock_held`。

## 日常檢查與 stale source

`/healthz` 只代表 process 存活；`/readyz` 代表 current feed 可以解析並通過 Server public key 驗證。使用 `/v1/source-status` 查看 `status`、`checked_at`、`last_success_at`、`coverage`、`revision` 與 typed `error_code`。

`partial`、`stale`、`unavailable` 或 `blocked_by_auth` 時，先確認對應 credentials、上游 HTTP status 與 collector log 的分類，再確認舊的 signed release 仍可下載。`disabled` 代表該 source 沒有在預設排程中執行，不是上游錯誤。不要把缺少資料補成零或 `CLOSED`，也不要把 fixture/replay 當作 live official data。

確認一次完整發布時，必須同時檢查 `/v1/source-status` 的來源時間、`/readyz` 的 feed revision，以及 `/feed.json` 的 `dataset_count`。`dataset_count: 0` 可以是來源成功後的有效空 feed；要從 source status 與 collector log 確認來源檢查成功，並確認新 revision 通過簽章驗證。來源故障時則應保留上一個可信 revision。直接呼叫官方 XML/API 只能證明上游可讀，不能取代 Collector cache 與 public release 驗證。

## Restart 與 backup

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml restart collector api proxy
docker compose -f deploy/docker-compose.yml logs --since=15m collector api proxy
```

backup 必須包含 `private_data`（source state 與 last-known-good cache）和 `public_release`（immutable releases 與 current pointer），private key 則使用 VPS secret manager 的獨立備份政策。不要將 raw snapshot 或 private key 放進 public release backup、HTTP response 或 issue。

## Rollback

publisher 會先在 staging 目錄完成 schema、hash、signature、size 與 chunk checks，最後才切換 current pointer；發布失敗時舊 current release 應保持可讀。遇到可疑的新 revision，先停止 collector：

```bash
docker compose -f deploy/docker-compose.yml stop collector
docker compose -f deploy/docker-compose.yml logs --since=30m collector
```

依備份或已驗證的 immutable revision 恢復 public release，再啟動 API 並確認 `/readyz`。修復上游或 key 問題後再啟動 collector。若 rollback 涉及資料契約、簽章 key 或 Web 靜態資產，須一併確認 Android 與 Flutter Web 的版本相容性。

## 安全界線

collector 是唯一可寫入 private cache 與 public release 的 service；API 只 read-only mount public release，沒有上游 API key 或 signing private key；Caddy 提供 Flutter Web 外殼、版本化門牌資產，並代理 `/healthz`、`/readyz`、`/feed.json`、`/releases/*` 和 `/v1/*`。

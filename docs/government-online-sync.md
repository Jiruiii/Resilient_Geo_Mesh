# Central Server 政府資料更新

目前唯一的正式收集／發布流程是：

```text
政府 API → collector → private source cache → signed immutable release
                                  ↓
                         Fastify read-only API / Caddy
```

`collector:start` 是唯一會寫入 source cache 與 public release 的排程入口。舊的 `government-publisher`／worker 與 Cloudflare Pages 發布流程已淘汰；`pipeline/cli.mjs` 只保留一次性 normalize、build、verify、attest 工具。Web 與 Android 的 signed feed／static layer client 已加入；Caddy／API 尚未部署到正式 HTTPS 網域，Android 資產內的預設網址仍需切換。

## 本機啟動

在 repo 根目錄準備 `.env`、AreaCatalog 與 Ed25519 key pair。Compose 需要 `CWA_API_KEY`、`NCDR_ALERT_API_KEY`、`SIGNING_KEY_ID`、兩個 signing key file 與 `SERVER_DOMAIN`；醫療座標補足使用公開的國土測繪中心 API，不需要額外 API key。

```bash
docker compose --env-file /absolute/path/to/.env \
  -f deploy/docker-compose.yml config --quiet
docker compose --env-file /absolute/path/to/.env \
  -f deploy/docker-compose.yml up -d --build
```

Collector 啟動時先完成一次收集，之後依 source registry 的 schedule 持續執行。App/API request 只讀取已發布檔案，不會觸發上游 API。

## 驗證與排錯

```bash
npm run server:health -- --base-url https://localhost
curl -ksS https://localhost/healthz
curl -ksS https://localhost/readyz
curl -ksS https://localhost/feed.json | jq '{revision, created_at, expires_at, dataset_count:(.datasets|length)}'
curl -ksS https://localhost/v1/source-status | jq
docker compose --env-file /absolute/path/to/.env \
  -f deploy/docker-compose.yml logs --since=15m collector
```

判定收集完成要同時檢查：`/readyz` 為 `ready`、feed revision 可驗證、source status 與 collector log 顯示來源檢查成功。`dataset_count: 0` 可以是來源成功後的有效簽章空 feed；不能只看資料筆數判定來源故障。`partial` 會保留 matched／unresolved 數量；醫療 layer 只發布有座標的院所，不會猜測或把缺口補成零。

`taiwan-medical` 的 `/v1/source-status` 會額外提供 `query_count`、`candidate_count`、`matched_count`、`unresolved_count`、`rejected_coordinate_count` 與 `coordinate_source_ids`，可直接用來核對座標覆蓋率。

來源檢查成功且當下沒有有效告警時，Collector 會發布簽章空 feed，讓已到期或撤銷的告警從兩端活躍資料移除。來源檢查失敗時，`current/feed.json` 與受影響的 layer 保持上一個可信版本，錯誤寫入 `current/source-status.json`。TDX、OSM 目前是 registry 中的 disabled source，不在預設收集。

## 醫療資料

`taiwan-medical` 以 MOHW 主檔提供機構代碼、名稱、地址與電話。Collector 會用 NLSC `COM_010` 半徑查詢建立可重現的台灣查詢網格，再合併設定中列出的官方衛生局座標來源。院所座標候選必須符合機構代碼／地址／縣市檢查；門牌包只接受唯一的正規化完整地址且同縣市的點位。多筆候選與無法匹配資料留在 `unresolved_medical`，不猜座標。

每個已發布 medical feature 都保留 `coordinate_source`、`coordinate_source_version` 與 `coordinate_match_method`。若官方座標服務失敗或結果為空，醫療 layer 不更新，沿用上一版已簽章 layer。覆蓋率報告中的 matched／unresolved 才是驗收依據，不宣稱所有院所都已定位。

可用下列環境變數調整查詢；fallback URL 必須是已審核的官方來源：

```dotenv
MEDICAL_COORDINATE_ENDPOINT=https://api.nlsc.gov.tw/other/MarkBufferAnlys/med
MEDICAL_COORDINATE_FALLBACK_ENDPOINTS=
MEDICAL_COORDINATE_RADIUS_METERS=25000
MEDICAL_COORDINATE_SPACING_METERS=30000
MEDICAL_COORDINATE_MAX_QUERIES=500
MEDICAL_COORDINATE_CONCURRENCY=4
MEDICAL_COORDINATE_TIMEOUT_MS=120000
```

## Backup、restore 與 release 清理

Backup 同時保存 `private_data` 與 `public_release`，但會拒絕把 signing private key 放進資料根目錄，也會在完成後驗證 feed、政府 chunks 與已存在的 layers。

```bash
npm run server:backup -- --destination /tmp/resilientgeo-backup
npm run server:restore -- --backup-root /tmp/resilientgeo-backup \
  --private-root /tmp/resilientgeo-private-restore \
  --public-root /tmp/resilientgeo-public-restore
```

清理預設只做 dry-run；它保留 current pointer、current feed 引用的 immutable release，以及最近 10 個 revision 或 30 天內版本中較寬的集合：

```bash
npm run server:cleanup -- --public-root /var/lib/resilientgeo-public
npm run server:cleanup -- --public-root /var/lib/resilientgeo-public --execute
```

先用 dry-run 檢查 `would_delete`，確認沒有 current 或仍被引用的版本後才使用 `--execute`。新 Server 的網域、HTTPS 外部部署及兩端實機驗收尚未完成。

## Web／Android 資料下載

- Caddy 提供 Flutter Web 外殼、簽章縣市門牌包與政府資料 API；底圖使用隨 Web／Android App 提供的 OSM PMTiles，不經由 Server 下載。
- Web 從同源 API 下載簽章避難所、醫療點位及醫療搜尋名錄，驗證後快取於 OPFS。找不到已驗證版本時不讀取舊版未核實醫療快照。
- Android 從政府服務網址取得相同的 layer manifest/chunks，由原生 verifier 驗簽並保存於 App 私有目錄。
- 門牌索引另以 22 縣市 catalog 與縣市壓縮包發布，不混入醫療 layer。現有 17 個縣市包已用 `central-server-2026` 簽章；基隆市官方 11509 CSV 已下載並完成座標／縣界試跑，但簽章私鑰路徑未設定，尚未重簽 catalog，因此現有版本仍將基隆列為 `unavailable`。連江、宜蘭、南投與嘉義市仍沒有已確認的公開完整座標來源。App 的 Web／Android 信任資產都保留舊 key 並加入該 public key；catalog 和資料位於 `deploy/public/address-packs/`，尚未部署到正式 HTTPS 網域。逐縣市來源與數量見[門牌索引涵蓋](../data_description.md#門牌索引涵蓋)。
- Web service worker 快取 Flutter 程式外殼與內建 OSM 資產；簽章資料另存在 OPFS／Android 私有目錄。
- 告警 feed 依 `expires_at`／撤銷狀態從目前活躍畫面與 Android 儲存移除；來源成功且目前沒有告警時可發布簽章空 feed，來源失敗則沿用上一個可信版本。

資料版本、醫療定位限制與逐縣市狀態見[資料說明](../data_description.md)及[點位涵蓋報告](data-coverage-2026-10-04.md)。目前底圖限制見根目錄 [Map_description.md](../Map_description.md)。

## 安全界線

- 上游 credentials 與 signing private key 只在 collector／secret mount，API container 沒有這些值。
- Public API 只提供 signed feed、allowlisted release chunks、signed layers 與 sanitized source status。
- Raw snapshots、source cache、座標查詢回應與私鑰不進 public release。
- 不把本機測試、fixture/replay 或 Docker 啟動成功描述為 Azure／公開 HTTPS 已部署。

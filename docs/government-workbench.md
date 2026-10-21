# 政府工作台操作說明

政府工作台提供政府人員登入、官方公告發布及民眾回報查證。第一版採單一試辦機關；系統管理者完成任職身分核實後，直接建立政府人員帳號。不串接機關 SSO、不開放自行註冊，也不要求第二位人員覆核。登入帳號不必是電子郵件。

## 架構與信任邊界

```text
Flutter Web／Android
      │ 同源 HTTPS /api/v1
      ▼
government-api ───── PostgreSQL
 (session／管理／outbox)   (帳號、回報、公告、稽核)
                            │
                            ▼
                 government-publisher
                  (中央 Ed25519 key)
                            │
                            ▼
                 signed immutable feed
```

- `government-api` 只持有 PostgreSQL 連線，不讀取簽章私鑰，也不寫 public release。
- `government-publisher` 在內部讀取 outbox，以中央 Ed25519 金鑰發布 `official.announcement` 與 `official.verified`。它和中央 collector 共用發布鎖及 release 儲存區。
- `data/administrative-area-directory.json` 是 API 驗證公告影響範圍的正式目錄；Compose 會唯讀掛載至 `/app/data/administrative-area-directory.json`。Flutter Web／Android 使用由同一來源產生的離線目錄與空間索引。
- 公開資料 API 仍只讀取已發布資料。Web 與 Android `SYSTEM_ADMIN` 透過線上工作台建立、修訂或撤回公告後，App 會自動檢查簽章 feed，並在中央 Publisher 發布新版本後更新本機通知；不必手動執行「政府資料更新」。Publisher 非同步處理 outbox，因此雲端公告不是 API 成功回應當下就能顯示。Android 裝置簽署的公告則在 Room 本機提交後立即出現在建立者手機，其他裝置在取得已發布 feed 或 Mesh 資料後顯示。
- 裝置簽章證明回報來自該裝置金鑰且內容未被改動；中央簽章證明官方發布來源與內容完整性。簽章本身不代表系統已獨立證明回報或公告的事實正確。
- 未查證回報仍顯示「未經查證，僅供參考」。`REFUTED` 會顯示官方否定結論，不會改成已確認。

## 部署與第一次啟用

目前工作台部署路徑是 VPS／Docker Compose，會建立 PostgreSQL 16 與工作台 API、內部發布 worker。現有 Azure Bicep／workflow 尚未佈建工作台資料庫與這兩個 service，因此不能把 Azure feed API 已部署視為政府工作台也已上線。以下命令從專案根目錄執行。先依[中央 Server runbook](central-server-runbook.md#initial-release)準備 Compose 所需的 `.env`、正式 Web build、上游 API credentials 及 signing key，再啟動服務：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml config --quiet
docker compose --env-file .env \
  -f deploy/docker-compose.yml up -d --build
```

`.env` 必須設定 `GOVERNMENT_DB_PASSWORD` 與 `GOVERNMENT_DB_PASSWORD_URLENCODED`。前者供 PostgreSQL 初始化；後者放在 `DATABASE_URL`，密碼含保留字元時需 URL encode；若選英數字密碼，兩個值相同。資料表會在 API、publisher 或 bootstrap CLI 啟動時建立。migration 會保留既有帳號與密碼，將原 email 識別欄位改為 account；尚未使用的邀請資料會移除。

Android debug 模擬器的工作台 API 預設使用 `http://10.0.2.2:8788/api/v1/`；Compose 將 `government-api` 的 8788 port 僅映射到本機 loopback。Android 地圖資料同步仍使用公開 API 的 8787 port。本機只測帳號功能時，設定上述兩個資料庫密碼後，可只啟動 PostgreSQL 與工作台 API：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml \
  up -d --build government-postgres government-api
```

可以在主機確認工作台 API 狀態：

```bash
curl -fsS http://127.0.0.1:8788/api/v1/healthz
```

Android release build 請以 `--dart-define=GOVERNMENT_API_BASE_URL=https://<工作台網域>/api/v1/` 設定可由手機連線的 HTTPS API 位址。Web 由 Caddy 同源提供，`/api/v1/*` 會轉送至工作台 API。若登入區顯示 `not_found`，先確認目前用的是工作台 API 路徑，而非只提供簽章資料的公開 feed API。

首位系統管理者必須由部署人員依人工任職核實結果建立。從安全的管理終端提供下列環境變數，再以 Compose 執行一次性 bootstrap；不要把正式密碼直接寫入命令歷史：

```bash
export GOV_ADMIN_ACCOUNT='admin'
export GOV_ADMIN_NAME='系統管理者姓名'
export GOV_ADMIN_AGENCY='試辦機關'
read -s GOV_ADMIN_PASSWORD
export GOV_ADMIN_PASSWORD
docker compose --env-file .env \
  -f deploy/docker-compose.yml run --rm \
  -e GOV_ADMIN_ACCOUNT -e GOV_ADMIN_NAME -e GOV_ADMIN_AGENCY -e GOV_ADMIN_PASSWORD \
  --entrypoint npm government-api run government:bootstrap-admin
unset GOV_ADMIN_PASSWORD
```

Bootstrap 只會在尚無 `SYSTEM_ADMIN` 帳號時成功；再次執行會拒絕建立。新管理者登入後，可在個人頁的「政府工作台 → 帳號管理」直接建立政府人員帳號或停用帳號。

## 帳號管理

1. 系統管理者先依機關內部程序核實人員任職身分，再透過政府工作台建立帳號、姓名、服務機關與初始密碼。一般人員不能自行註冊，也不能建立其他帳號。
2. 帳號去除前後空白並以不區分大小寫方式登入，可使用非電子郵件名稱。系統管理者應透過機關核准的安全管道交付帳號與初始密碼。
3. 密碼至少 12 個字元，不限制字母、數字、大小寫或符號組成，使用 scrypt 雜湊；資料庫不保存明碼。API 一般 JSON 請求仍有 64 KiB 傳輸大小上限。
4. 系統管理者可停用帳號；該帳號既有工作階段會立即撤銷。不可停用最後一位系統管理者。

Web 以同源 `HttpOnly`、`SameSite=Strict` session cookie 登入，變更請求使用 CSRF token；HTTPS 時 cookie 加上 `Secure`。Android 以 bearer session token 登入，token 使用 Android Keystore 加密後存於 App 私有偏好設定。密碼使用 scrypt 雜湊；資料庫僅保存 session token 雜湊。

## 工作台流程

### 官方公告

- 公告的影響範圍使用 `attributes.affected_area_ids`，可選縣市、鄉鎮市區、多個區域或明確選擇全台灣 `tw.national`。點選地圖位置後，App 會用隨附的正式鄉鎮界線建議所在行政區；只有唯一命中才會自動帶入。發布者可以搜尋、調整或多選範圍；無法唯一判定時需自行選擇，不會自動改成全台灣。座標位置與影響範圍是獨立欄位，兩者不一致時需確認後才能發布。
- API 以正式行政區目錄驗證非空、無重複且存在的區域 ID，並將影響範圍寫入公告及 outbox。中央 feed 與既有下載傳輸仍保留 `area_id=tw.national` 作為相容 bucket；它不代表新公告的實際影響範圍。舊版事件沒有 `affected_area_ids` 時，客戶端以 `area_id` 相容顯示。
- 新公告依安全提醒、天氣、道路、避難收容、物資站及其他分類顯示在各自的「政府公告」通知群組。地圖與通知卡片共用類別圖示，避難收容使用收容圖示，物資站使用物資站圖示。
- 建立或修訂欄位：標題、內容、類別、嚴重程度與有效期限。有效期限以台灣時間透過日期／時間選擇器輸入，畫面使用 `yyyy/MM/dd HH:mm:ss`，API 與簽章事件仍保存 ISO 8601 UTC，期限最多 90 天。
- 地圖位置選填。人員可搜尋 App 隨附的台灣離線地名索引，或移動地圖中心圖釘選點；未指定位置時公告只出現在通知列表。
- API 將變更寫入 PostgreSQL 與 outbox。Publisher 用中央簽章發布 event-v0 `official.announcement`；修改沿用同一 `event_id` 並遞增版本，撤回則發布新的撤回版本。工作台的「撤回並隱藏」會將已撤回公告從清單移除，但保留資料庫稽核紀錄與簽章發布歷史。
- 雲端工作台變更成功後，Android 會自動同步並讀取已驗證的 Room 快照；Web 會檢查已驗證的 feed metadata revision，發現新版本後才載入完整 feed。新增與修訂等中央簽章版本出現後更新通知；撤回版本出現後，已撤回公告從有效通知中消失。若 Publisher 尚未完成發布，App 會短暫重試；不會把未簽章的 API 回應直接顯示為官方通知。
- 有座標的公告可出現在地圖；沒有座標的公告只顯示在通知列表。

### Android 政府手機離線警告

- 政府人員首次在 Android 登入時，App 以 Android Keystore 中獨立的 Ed25519 金鑰向 `government-api` 登錄公鑰。帳號必須為啟用中的 `GOVERNMENT`；管理者停用帳號或撤銷手機後，API 不再核發憑證或接受該手機的新上傳。
- 設備憑證有效 7 天，由 `government-publisher` 以中央金鑰簽署；API 僅傳回憑證，沒有中央私鑰。Android 會檢查中央簽章、裝置公鑰指紋、發布權限及效期，再保存憑證。連線後會在剩餘效期 24 小時內排入續期。
- 憑證有效時，Android 可離線建立公告並選擇影響範圍。事件以手機私鑰簽署，`affected_area_ids` 會納入簽章內容，並同時保存到 Room、mesh chunk 與雲端補傳佇列。事件本身的有效期限最多 90 天；憑證之後到期，不會讓憑證有效期間簽出的未過期警告失效。
- 政府警告使用 `official.announcement`、`source=GOVERNMENT`，並以 `affected_area_ids` 記錄公告範圍；`area_id=tw.national` 保留作為既有傳輸相容欄位。沒有選地圖位置時不顯示地圖標記。手機端先以政府憑證驗簽，公開中央 feed 仍會另以中央金鑰簽署 manifest 與 chunk。
- Android 只在使用者已啟用既有「緊急模式」時參與 mesh；App 不會自行啟動藍牙或附近裝置廣播。已簽警告會保留供轉傳；目前 mesh 協定沒有對發布端回報每一台 peer 是否收到，因此畫面不宣稱已送達特定手機。
- 公告本機提交後即出現在建立者手機，不需先執行「政府資料更新」。緊急模式已開啟時，本機 inventory 變更會要求現有 Mesh 服務儘快與近期 peer 同步；緊急模式關閉時保留公告並提供啟用按鈕，不會自行開啟無線電。
- 上傳佇列在公告建立後排入 Android 網路工作；網路恢復或 App 回到前景時會重試，既有工作台開啟期間每 5 分鐘的重試也保留，亦可手動按「補傳待上傳警告」。Android 系統控制背景工作的實際執行時間。補傳保留原始事件 JSON、`event_id` 與 `payload_hash`；重複請求具冪等性。伺服器成功收件只代表進入發布佇列，App 收到簽章 feed 並核對同一事件後才顯示「已發布」。過期且未上傳的佇列項目會標記為過期，不會送出。
- 撤銷透過中央簽章的 `government-device-revocations` feed 傳播；資料不包含帳號名稱。Android 同步時先處理撤銷資料，再驗證警告，並透過 mesh relay 原始簽章資料。設備在已知撤銷時間之後簽出的事件會拒絕；撤銷之前的有效警告仍可驗證。離線手機只能依最近一次取得的撤銷資料判斷，工作台會顯示撤銷資訊同步時間。
- 離線登入僅允許曾登入的啟用政府帳號，且手機本機憑證狀態為 `AUTHORIZED`、憑證未過期時開啟。這只能證明裝置仍持有最後一次取得的有效憑證；離線期間的新停權或撤銷要等資料同步後才會得知。登出清除政府帳號快取與 API session，不會刪除已簽警告、mesh chunk 或待補傳資料。

Web 政府工作台仍透過線上 API 建立中央簽章公告，不執行 BLE mesh。Web feed 驗證器同時驗證 Android 設備簽章警告及中央撤銷資料；撤銷事件留在已驗證的離線快取中供警告驗證，但不會顯示在通知列表。

### 本機通知接收區域

- 個人設定的「通知接收區域」可搜尋並選擇縣市、鄉鎮市區或全台灣。縣市選擇涵蓋其所屬鄉鎮；單選鄉鎮也會收到標示縣市級的公告。
- 接收偏好存在目前 App 安裝或瀏覽器的本機偏好 `map.notification_area_ids`。它只篩選已同步至本機的通知清單、分類、未讀數及「全部已讀」操作範圍；不刪除地圖事件、不改變 feed 下載區域或伺服器傳送範圍。未指定或偏好無法解析時採全台灣；事件範圍無法對應目錄時保留顯示。
- 這項設定是本機通知篩選，不是保證只會收到指定區域資料的伺服器推播訂閱。

### 回報查證

- Web 回報需要線上連線，以瀏覽器 IndexedDB 中不可匯出的裝置私鑰產生 Ed25519 簽章；Android 仍可離線及經 mesh 回報，連線後將原始簽章事件排入重試上傳佇列。
- API 驗證 event-v0 結構、裝置簽章、payload hash、回報期限及欄位，重複上傳具冪等性。未查證資料狀態仍是 `UNVERIFIED`／`PENDING`。
- 政府人員選擇 `CONFIRMED` 或 `REFUTED`，並可填寫查證說明。API 會核對原回報 `payload_hash`，把決策寫入 outbox；Publisher 以中央金鑰簽署 `official.verified`，並在事件中引用原回報雜湊。
- 過期回報不能上傳或查證。`REFUTED` 不會被畫成已確認；其原回報仍可在通知中顯示否定結論。

## API 合約

所有端點經 Caddy 同源 HTTPS 提供；政府帳號端點需有效 session，寫入請求另需 Web CSRF 驗證。Android 使用 bearer token。

| 方法與路徑 | 用途 |
| --- | --- |
| `POST /api/v1/auth/sessions` | 登入 |
| `GET /api/v1/auth/me` | 讀取登入帳號及更新 Web CSRF token |
| `DELETE /api/v1/auth/sessions/current` | 登出並撤銷 session |
| `POST /api/v1/government/users` | 系統管理者直接建立政府人員帳號 |
| `GET /api/v1/government/users`、`PATCH /api/v1/government/users/{userId}` | 系統管理者列出、停用或重新啟用帳號 |
| `POST /api/v1/government/devices` | 政府人員登錄目前 Android 裝置公鑰並排入憑證簽發 |
| `GET /api/v1/government/devices/current`、`POST /api/v1/government/devices/current/renew` | 查詢或續期目前裝置的中央簽章憑證 |
| `GET /api/v1/government/devices`、`DELETE /api/v1/government/devices/{deviceId}` | 系統管理者查看或撤銷裝置 |
| `POST /api/v1/government/warnings` | 驗證並冪等補傳原始設備簽章警告 |
| `POST /api/v1/crowd-reports` | 上傳 device-signed crowd event，公開路徑但伺服器會驗簽 |
| `GET /api/v1/government/reports?status=PENDING` | 查閱待查回報 |
| `POST /api/v1/government/reports/{eventId}/attestations` | 提交 `CONFIRMED`／`REFUTED` 及原 payload hash |
| `GET /api/v1/government/announcements` | 列出公告及版本 |
| `POST /api/v1/government/announcements` | 建立公告 |
| `PUT /api/v1/government/announcements/{eventId}` | 修訂公告 |
| `DELETE /api/v1/government/announcements/{eventId}` | 撤回公告 |
| `GET /api/v1/healthz` | 工作台 API 與 PostgreSQL 健康狀態 |

登入請求使用 `{"account":"admin","password":"..."}`。系統管理者新增人員時提交 `account`、`display_name`、`agency` 與非空 `password`；新帳號固定為 `GOVERNMENT` 角色。

建立及修訂公告的 JSON 必須帶非空 `affected_area_ids` 陣列，元素為正式目錄中的行政區 ID 或唯一的 `tw.national`。API 對陣列驗證 ID 存在、無重複，並保留 `area_id=tw.national` 做舊版相容。Android 離線警告也將相同陣列納入事件 payload hash 及裝置簽章。

`GET /api/v1/healthz` 回傳 `announcement_scope_schema=affected_area_ids-v1`。Web 與 Android 的中央公告建立／修訂流程會先確認此能力；缺少標記時停止送出，避免舊 API 接受請求卻忽略影響範圍。中央公告新增或修訂後，工作台重新讀取公告清單並比對版本與 `affected_area_ids`；不一致時顯示錯誤。編輯器分開顯示 API 已儲存的範圍和本次尚未發布的選擇。舊公告缺少 `affected_area_ids` 時，座標僅提供建議，需選取範圍並修訂發布才能寫入正式範圍。

## 備份與還原

既有 `server:backup` 保存的是 private source data 與 public release，並不包含 PostgreSQL。工作台資料需另作邏輯備份，將輸出檔保存於限制存取的備份位置：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml exec -T government-postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > /absolute/path/to/backup/government-db.sql
```

還原前先停止 `government-api` 與 `government-publisher`，備份目前資料庫，再透過 PostgreSQL 容器匯入：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml stop government-api government-publisher
cat /absolute/path/to/backup/government-db.sql | \
  docker compose --env-file .env \
    -f deploy/docker-compose.yml exec -T government-postgres \
    sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose --env-file .env \
  -f deploy/docker-compose.yml start government-api government-publisher
```

同時依中央 Server runbook 備份 private/public volumes。PostgreSQL 備份包含政府帳號識別資料、回報、公告與稽核紀錄，需套用適當的加密、存取控制與保留期限。

## 驗收指令

```bash
npm run test:server
cd flutter && flutter analyze --no-pub && flutter test --no-pub
cd ../android && ./gradlew testDebugUnitTest
```

容器資料庫 migration、正式網域 HTTPS、瀏覽器裝置金鑰支援、Android Keystore 與離線佇列仍需在目標部署環境／實機完成驗收；本機單元測試不代表已部署或已做實機驗證。

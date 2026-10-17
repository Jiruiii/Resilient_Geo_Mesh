# 需要救援／求救點 設計規格

> 狀態：2026-10-12 規劃定稿，待使用者審閱規格後進入實作計畫。
> 分支：`feat/rescue-request`（以 `origin/main` 為基底的獨立 worktree）。
> 範圍：共用資料契約、Android、Flutter（Android 與 Web）、server 與 Azure 部署，於同一實作批次完成。

## 1. 目標與非目標

**目標**

- 使用者可以為自己（或身邊需要幫助的人）建立「求救點」，描述需要的救援。
- 求救點以獨立的事件類型在 mesh、server 與 Web 之間流通，並清楚標示未經查證。
- 若情況是「受困於瓦礫或倒塌建物下」，首頁突出顯示「發出定位警報聲」，由使用者主動觸發本機發聲，協助附近救援者循聲定位。

**三種語意必須分清楚**

| 名稱 | 意義 |
|---|---|
| `CROWD_REPORT`（既有） | 使用者看到並回報一個災情，包括第三者回報他人受傷的「受困／受傷」 |
| `RESCUE_REQUEST`（新增） | 使用者本人或現場人員正在請求救援 |
| 本機定位警報 | 只讓本機發聲，不代表事件已同步，也不代表已聯絡 119 |

**非目標**

- 不取代 119，也不宣稱已派遣救援。
- 不做震動、閃光燈、系統通知提醒（列為後續）。
- 不自動調整系統音量。
- Web 不加入 BLE／Wi-Fi mesh。

使用者看到的名稱：主要功能為「需要救援」，地圖事件為「求救點」。不使用「急救位置」，以免和醫療院所圖層混淆。

## 2. 事件契約

### 2.1 識別

| 欄位 | 值 |
|---|---|
| `namespace` | `crowd.rescue` |
| `event_type` | `RESCUE_REQUEST` |
| `source` / `source_version` | `CROWD` / `rescue-request-v0` |
| `event_id` | `rescue:<signing_key_id 去掉 "device:" 後的 32 hex>:<小寫 UUID>` |
| `geometry` | Point，座標四捨五入到小數 6 位，須在台灣含離島範圍內（與 crowd report 相同） |
| 簽章 | 裝置 Ed25519 金鑰，`device:` key id，與 crowd report 相同的自我證明規則 |

`event_id` 內嵌完整的簽章者指紋。驗章時檢查 `crowd.rescue` 事件的 `event_id` 前綴等於簽章者指紋，不符就在 trust 階段拒收。

### 2.2 attributes

| 欄位 | 規則 |
|---|---|
| `request_type` | `FIRST_AID_NEEDED`（需要醫療或急救協助）、`IMMOBILE`（無法移動）、`TRAPPED`（一般受困）、`TRAPPED_DEBRIS`（受困於瓦礫或倒塌建物下）、`OTHER_RESCUE`（其他救援需求） |
| `status` | `ACTIVE`、`RESOLVED`、`CANCELLED`。過期沿用 `expires_at`，不另設狀態 |
| `subject` | `SELF`（本人）或 `OTHERS`（現場其他人） |
| `people_count` | 整數 1–50 |
| `triage` | 物件，四個欄位 `immobile`、`breathing_difficulty`、`severe_bleeding`、`conscious`，值為 `YES`／`NO`／`UNKNOWN` |
| `description` | trim 後最多 160 個 code point，可為空字串 |
| `location_source` | `CURRENT_LOCATION` 或 `MAP_PICK` |
| `location_hint` | 選填，格式與 crowd report 相同 |
| `first_issued_at` | v1 的 `issued_at`，之後所有版本不得修改 |
| `area_id` / `theme` | `crowd` / `rescue` |

`subject == SELF` 時 `triage.conscious` 固定為 `YES`。

### 2.3 urgency

`severity` 是急迫程度的唯一來源，不另設 `attributes.urgency`。`severity` 必須等於下列推導結果，否則拒收：

1. `request_type == TRAPPED_DEBRIS` → `CRITICAL`
2. `breathing_difficulty == YES`、`severe_bleeding == YES` 或 `conscious == NO` → `CRITICAL`
3. `request_type ∈ {TRAPPED, IMMOBILE}` 或 `immobile == YES` → `HIGH`
4. 其他 → `MEDIUM`

`UNKNOWN` 不提高也不降低等級。求救沒有 `LOW`。人數不影響等級，另外顯示。

### 2.4 TTL 與延長

- 建立：`expires_at = issued_at + 6h`。
- 延長（續報）：只能在到期前、狀態為 `ACTIVE` 時進行，新版本 `expires_at = min(now + 6h, first_issued_at + 72h)`。
- 到達 72 小時上限後不能再延長，UI 改為「重新建立求救」，以原內容預填並產生新的 `event_id`。
- 過期後不能延長，同樣只能重新建立。
- 不需讀取舊版本即可檢查的規則（validator 直接拒收）：`event_version == 1` 時 `first_issued_at == issued_at`；`expires_at - issued_at ≤ 6h`；`expires_at ≤ first_issued_at + 72h`。

### 2.5 範例

```json
{
  "schema_version": "event-v0",
  "namespace": "crowd.rescue",
  "event_id": "rescue:<32 hex>:<uuid>",
  "event_type": "RESCUE_REQUEST",
  "geometry": { "type": "Point", "coordinates": [121.588123, 25.069876] },
  "severity": "CRITICAL",
  "source": "CROWD",
  "source_version": "rescue-request-v0",
  "event_version": 1,
  "issued_at": "2026-10-12T03:00:00Z",
  "expires_at": "2026-10-12T09:00:00Z",
  "attributes": {
    "request_type": "TRAPPED_DEBRIS",
    "status": "ACTIVE",
    "subject": "SELF",
    "people_count": 2,
    "triage": { "immobile": "YES", "breathing_difficulty": "NO", "severe_bleeding": "UNKNOWN", "conscious": "YES" },
    "description": "一樓樓梯間，敲牆有回應",
    "location_source": "CURRENT_LOCATION",
    "first_issued_at": "2026-10-12T03:00:00Z",
    "area_id": "crowd",
    "theme": "rescue"
  },
  "signing_key_id": "device:<32 hex>",
  "signer_public_key": "<base64 SPKI>",
  "payload_hash": "sha256:<64 hex>",
  "signature_algorithm": "Ed25519",
  "signature": "<base64>",
  "provenance": { "original_source": "crowd-app", "received_at": "2026-10-12T03:00:00Z", "transport_source": { "kind": "local_report" } }
}
```

JS（`pipeline/lib/rescue-request.mjs`）、Kotlin（`RescueRequestFactory.kt`）與 Web JS（`flutter/web/rescue_outbox.js`）必須產出位元相同的結果，由共用 fixture `fixtures/rescue-requests-v0.json` 鎖定。

## 3. 套用規則（JS `ingestEvent` 與 Kotlin `EventIngestor` 同步）

1. **同一簽章者才能更新**：任何 `crowd.*` 事件的新版本，`signing_key_id` 必須等於已儲存版本，否則拒收（`signer_mismatch`）。既有 `crowd.reports` 永遠是 v1，不受影響。
2. **終態不可逆**：已儲存版本為 `RESOLVED` 或 `CANCELLED` 時，拒收之後的任何版本。
3. **終態不縮短 TTL**：轉為 `RESOLVED`／`CANCELLED` 的版本必須沿用前一版的 `expires_at`，讓持有舊版的節點在舊版過期前收到終態。
4. **版本上限**：`event_version` 最大 200。
5. **不可改的欄位**：`first_issued_at` 跨版本不得改變。
6. 版本倒退、同版本不同內容沿用現有拒收規則。

第 2、3、5 條需要讀取已儲存版本才能判斷；server 與 Android 共用同一套判斷邏輯，各自實作並以 fixture 測試對齊。

## 4. 生命週期

```
建立(v1, ACTIVE)
      │
      ▼
   ACTIVE ──更新/延長(vN+1, ACTIVE)──► ACTIVE
      │
      ├── 我已安全/已獲救 (vN+1, RESOLVED, expires_at 不變) ──► 終態
      ├── 取消誤報        (vN+1, CANCELLED, expires_at 不變) ──► 終態
      └── 到期 (expires_at) ──► 已過期
```

- 更新可改：描述、人數、triage、位置、`request_type`；urgency 重新推導。
- 本機更新冷卻 30 秒。
- 每台裝置同時最多 1 筆 `ACTIVE` 求救。
- 到期前 30 分鐘，首頁顯示 in-app 提醒卡片，提供「延長 6 小時」。
- 首頁只把「最新版本為 ACTIVE 且未過期」的自己的求救視為進行中。
- App 重開後恢復：
  - Android：從 Room 查詢自己的 key 在 `crowd.rescue` 下的最新版本，經 bridge 方法 `getOwnRescueRequests` 回傳。
  - Web：從 IndexedDB 的已簽章事件與 outbox 恢復。

## 5. Mesh 傳輸（Android）

- 新 dataset：`crowd-rescue`，namespace `crowd.rescue`，manifest id `crowd-rescue:none`，`dataset_version` 固定 1。
- 一筆求救一個 chunk，`chunk_id = crowd-rescue:<event_id>`，由簽章裝置自己包裝並簽 chunk；中繼節點原樣轉傳。
- 新版本沿用同一個 `chunk_id`，peer sync 以 `chunk_hash` 不同判定為 stale 並重新拉取，不需要改協定。
- 加入 `KNOWN_DATASETS`，讓新節點也會主動請求。
- 保留上限：他人的求救最多 300 筆，淘汰時先淘汰終態、再淘汰最舊的 `MEDIUM`，`CRITICAL` 最後。過期的求救移出轉傳清單。
- 舊版 App 不認得此 dataset，會在驗章時拒收；結果是舊版 App 不轉傳求救，但也不會誤顯示。

## 6. Server 與 Azure

### 6.1 API

`POST /v1/crowd/rescue-events`

- body 上限 8 KB，內容為一筆已簽章事件。
- 只接受 `namespace == crowd.rescue` 且 `signing_key_id` 為 `device:`；其他一律拒收，`official.*` 在 trust 階段就會被拒。
- 驗證：`verifyEvent`、rescue attribute validator、§3 套用規則、event_id 綁定。
- 時間：`issued_at` 比 server 時間超前超過 5 分鐘就拒收；已過期就拒收。離線排隊後才上傳的事件只要未過期即可接受。
- 冪等：與已儲存版本 `payload_hash` 相同時回 `200 already_accepted`。
- 速率限制：每個 key 每 60 秒最多 3 次寫入；每個 IP 每 10 分鐘最多 20 次；每個 key 最多 1 筆 ACTIVE。
- 回應只回傳結果代碼，例如 `accepted`、`already_accepted`、`rejected:<代碼>`，不回顯描述或座標。

`GET /v1/crowd/rescue-events?bbox=minLon,minLat,maxLon,maxLat`

- bbox 必填，範圍上限約 5 km × 5 km（經緯度各 0.05 度）。
- 只回傳最新版本為 ACTIVE 且未過期的完整已簽章事件；server 不重新簽章，`provenance.transport_source.kind` 設為 `server`（provenance 不在簽章範圍）。
- 每個 IP 有查詢頻率限制。

Log 只記錄 event_id 的 hash、結果代碼與時間，不記錄描述、座標或 IP 以外的識別資訊。

### 6.2 儲存

- 每個 event 一個 blob：`rescue/<event_id 的 sha256>.json`，以 ETag 條件寫入保證版本單調。
- 本機開發與測試使用檔案實作，介面相同。
- 速率限制計數器放在各 replica 記憶體；`maxReplicas` 為 2，實際上限最多為設定值的 2 倍，文件中註明，之後可改用 Azure Table。

### 6.3 Azure 部署（`deploy/azure/main.bicep`）

- 新增私有 container `resilientgeo-crowd`（`publicAccess: 'None'`）。
- 新增 role assignment：API identity 對這個 container 有 Blob Data Contributor，scope 只限這個 container。
- API 新增環境變數 `AZURE_CROWD_CONTAINER`。
- 新增 lifecycle management policy：`rescue/` 前綴的 blob 在最後修改 7 天後刪除。
- 既有 `resilientgeo-control` 對 API 仍然只讀；Caddy 不需修改。
- 更新 `server/test/deployment-config.test.mjs` 與 `docs/central-server-runbook.md`。

### 6.4 公開範圍（決策 A）

求救由裝置簽章，server 無法刪改內容後再轉發，否則簽章失效。因此 server 完整轉發，以下列方式降低批量抓取：bbox 範圍上限、IP 頻率限制、只回傳進行中的求救、過期 7 天後刪除、表單明確警告描述會公開。

## 7. Android 線上同步

- 上傳：裝置有網路時，把自己的 `crowd.rescue` 最新版本上傳到 server；記錄每個版本的上傳結果（未上傳、已接受、被拒＋原因）。
- 下載：有網路時以目前位置周邊的 bbox 查詢 server，收到的事件一律經 `EventVerifier` 與 `EventIngestor`，通過後包成 chunk 進入 mesh 轉傳。
- 下載到的事件由原簽章裝置的 key 簽章，Android 不重簽，所以轉傳後其他節點仍能驗證來源。
- 上傳與下載掛在既有的線上同步排程（`online/*`），不新增常駐背景工作。

## 8. Web 送出

- 金鑰：WebCrypto Ed25519，private key 設為 non-extractable，存在 IndexedDB；公鑰匯出 SPKI，key id 規則與 Android 相同。
- 建立事件、canonicalize 與簽章都在 `flutter/web/rescue_outbox.js`，canonicalize 移植 `pipeline/lib/canonical.mjs`，以 node 測試對 fixture 驗證。
- 事件先存入 IndexedDB outbox；在 `online` 事件、App 啟動、每 60 秒嘗試上傳。
- 送出狀態：

| 狀態 | 顯示 |
|---|---|
| `waitingUpload` | 已在本機簽署，等待上傳，尚未送出 |
| `uploading` | 上傳中 |
| `accepted` | 伺服器已接收，仍未經查證 |
| `rejected(原因)` | 未送出：原因；不顯示成功 |

- 地圖：Web 每 60 秒以目前視野（受 bbox 上限裁切）查詢 GET，收到的事件在瀏覽器端驗章後才顯示；瀏覽器不支援 Ed25519 驗章時不顯示他人求救，並提示原因。
- 限制與降級：
  - 瀏覽器不支援 Ed25519：顯示「此瀏覽器無法安全簽署，無法送出求救」，警報聲仍可用。
  - 清除網站資料或使用無痕模式會遺失金鑰，之後無法更新或取消舊求救；建立前先提示。
  - 離線時只能暫存，頁面需保持開啟或之後重開才會上傳；不使用 Background Sync。

## 9. Flutter 共用 UI

### 9.1 入口與表單

- 首頁快速操作新增「需要救援」。
- 表單步驟：
  1. 選擇 `request_type`（五個選項）與 `subject`。
  2. 結構化問題：是否無法移動、是否呼吸困難、是否大量出血、是否清醒（`SELF` 時不問）；每題可選「是／否／不確定」。
  3. 人數。
  4. 位置：目前位置、地圖選點、既有離線地址搜尋。
  5. 描述，附提示「請勿輸入姓名、電話、身分證號等非必要個資；描述會公開給收到求救的人」。
- 推導出的急迫程度與原因即時顯示，例如「危急：受困於瓦礫」；沒有 urgency 選單。
- 確認頁顯示：位置、類型、急迫度與原因、人數、描述、未經查證警告、「不能取代 119」。
- 送出中停用按鍵，防止重複提交。失敗時顯示真實原因，不顯示成功。
- 「需要救援」sheet 永遠提供「只發出定位警報聲」入口，不需要送出求救。
- 既有「回報警示」的「受困／受傷」保留，旁邊加註「若是你或現場有人需要救援，請改用『需要救援』」。

### 9.2 首頁求救狀態卡片

有進行中的自己的求救時，首頁頂端顯示卡片：類型、急迫度、送出狀態、到期時間，以及「更新」「延長」「我已安全／已獲救」「取消誤報」。`TRAPPED_DEBRIS` 時卡片最上方是大型的「發出定位警報聲」按鍵。

### 9.3 地圖 marker

| 維度 | 編碼 |
|---|---|
| 類型 | 圓形底座內的圖示：`FIRST_AID_NEEDED` HeartPulse、`IMMOBILE` Accessibility、`TRAPPED` DoorClosed、`TRAPPED_DEBRIS` BrickWall、`OTHER_RESCUE` LifeBuoy |
| 急迫度 | 底色（危急紅、高橙、中黃）加右上角文字角標「危」「高」「中」 |
| 驗證 | 未驗證：紫色虛線外環＋左下「?」角標；官方確認：青色實線外環＋「✓」角標 |
| 人數 | 下方小標籤「N 人」 |

- 只畫最新版本為 ACTIVE 且未過期的求救；終態與過期不畫，只在通知列表與自己的紀錄中出現。
- Cluster 與行政區彙總新增求救數與是否有 `HIGH`／`CRITICAL` 求救，泡泡顯示「SOS n」文字。
- semantic label 範例：「求救點：受困於瓦礫或倒塌建物下，急迫程度危急，未經查證，進行中，2 人」。
- 詳情頁：類型、急迫度與原因、驗證狀態、狀態、人數、描述、位置來源、最後更新、到期時間，固定顯示「不代表已派遣救援」。官方確認只對被確認的那個版本有效，更新後顯示「官方確認的是先前版本」。
- marker 是 Flutter widget，Android 與 Web 共用同一份程式碼。

### 9.4 其他既有邏輯調整

- `HazardOverlay`：`crowd.rescue` 不參與路線加權。
- `corroboration.dart`：求救不參與「N 人回報」。
- `route_event_snapshot.dart`、通知列表：求救顯示為「求救點」，不是「民眾警示」。

## 10. 本機定位警報

### 10.1 state machine（Flutter 共用 `SirenController`）

```
idle ──tap──► starting ──ok──► playing ──60s──► autoStopped ──tap 重播──► starting
                 │               │  ├──tap 停止──► stopping ──► idle
                 │               │  └──失去音訊焦點/來電──► interrupted
                 ▼               ▼
              failed(原因)    failed(原因)
autoStopped／interrupted／failed ──關閉提示──► idle
```

失敗原因：`volumeZero`、`focusDenied`、`browserBlocked`、`audioInitFailed`、`unsupported`。勿擾模式可能阻擋時顯示警告 `dndMayBlock`，但仍嘗試播放。

### 10.2 警報音

- 由 `tools/audio/generate-locator-tone.mjs` 產生固定的 WAV：約 3 kHz 的三短聲，每聲 0.4 秒、間隔 0.3 秒、每輪停 1.5 秒，沒有滑音，不模仿警笛。
- 同一個檔案放在 Android `res/raw/locator_siren.wav` 與 `flutter/web/audio/locator_siren.wav`，測試比對兩者 sha256 相同。

### 10.3 共同規則

- 只在使用者點擊後播放，送出求救後不自動播放。
- 每次播放 60 秒自動停止，可重播。
- 播放中顯示全寬「停止警報」按鍵，以及固定文字：「此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。」
- 不調整系統音量。
- 不需要網路、簽章或 Room。

### 10.4 Android（背景播放）

- 新增 `LocatorSirenService`，`foregroundServiceType="mediaPlayback"`；不修改 `EmergencyModeService`。
- 新增權限：`FOREGROUND_SERVICE_MEDIA_PLAYBACK`、`WAKE_LOCK`（皆為安裝時授予）。
- 只在使用者於前景點擊時呼叫 `startForegroundService`，符合 Android 12+／14+ 的啟動限制。
- 播放：`MediaPlayer` 循環播放，`AudioAttributes(USAGE_ALARM, CONTENT_TYPE_SONIFICATION)`，`setWakeMode(PARTIAL_WAKE_LOCK)`。
- 音訊焦點：`AUDIOFOCUS_GAIN_TRANSIENT`；被拒進入 `failed(focusDenied)`；失去焦點（來電）停止並進入 `interrupted`。
- 預檢：`STREAM_ALARM` 音量為 0 時 `failed(volumeZero)`；勿擾為 `INTERRUPTION_FILTER_NONE` 或 `ALARMS` 時顯示 `dndMayBlock` 警告。
- 通知：專用 channel「定位警報」；`VISIBILITY_PUBLIC`，鎖屏可見；含「停止警報」動作。
- 60 秒由 service 自己計時停止並 `stopSelf()`；App 從最近清單滑掉時繼續播放直到時間到或按停止。
- 狀態經 EventChannel 回報 Flutter；Flutter 重新連上時查詢目前狀態。
- 通知權限（Android 13+）：建立 `TRAPPED_DEBRIS` 求救時請求；被拒時播放前提示「鎖屏時只能回到 App 內停止」。
- Google Play：上架時在 Play Console 申報 mediaPlayback 前景服務用途並附操作影片。

### 10.5 Web

- 在點擊 handler 內建立 `AudioContext` 並 `resume()`；`state !== 'running'` 或解碼失敗即 `failed`，不顯示播放中。
- `visibilitychange` 為 hidden 時不主動停止；回到頁面時提示「瀏覽器可能已暫停聲音」。
- UI 固定說明：不保證背景或鎖屏時持續播放；無法偵測系統音量，請確認裝置未靜音。

## 11. 隱私、安全與濫用

- 表單警告：描述會公開；勿輸入非必要個資；同一裝置的回報可被串連。
- 固定顯示：不能取代 119；未經查證，不代表已派遣救援。
- 只有原簽章裝置能更新、取消、標記已獲救（§3）。
- 濫用限制：每裝置 1 筆 ACTIVE、本機 30 秒冷卻、server 速率限制與 8 KB 上限、版本上限 200、mesh 他人求救 300 筆上限。
- Android Logcat 與 server log 不記錄描述與座標；錯誤訊息只含代碼。
- 失敗處理：簽章、Room、上傳任一步失敗都顯示真實原因，不顯示成功；警報聲不受影響。

## 12. 相容性

- `crowd.reports` 格式、fixture、TTL 不變；舊 `TRAPPED_INJURED` 照常解析、顯示、轉傳。
- Room 不需 schema migration，以 namespace 區分。
- §3 第 1 條套用到 `crowd.reports` 不影響既有資料（永遠是 v1），以測試鎖定。
- 舊版 App 不轉傳 `crowd-rescue`。

## 13. 驗收

### 共用契約與 server

- 舊 `TRAPPED_INJURED` 仍可解析與顯示。
- `RESCUE_REQUEST` 可 canonicalize、sign、verify、store、relay。
- JS、Kotlin、Web JS 對 fixture 的 bytes、hash、signature 一致。
- 拒收：不合法的 `request_type`、`status`、`severity`（與推導不符）、`subject`、`triage`、人數、座標、描述；event_id 與指紋不符；device key 簽的 `official.*`；他人 key 的更新；版本倒退；終態後的版本；終態縮短 `expires_at`；延長超過 72 小時；`first_issued_at` 被改。
- server：official 偽造、超過 8 KB、速率限制、bbox 超過上限、重放（冪等）、離線排隊後上傳的未過期事件可接受。
- 部署設定測試涵蓋新 container、role scope、lifecycle policy。

### Flutter／Android

- 首頁可開啟「需要救援」；可用目前位置、地圖選點、離線地址搜尋。
- `TRAPPED_DEBRIS` 固定顯示 `CRITICAL`；推導規則表格測試。
- 確認頁欄位完整；防止重複提交；失敗不顯示成功。
- App 被終止後重開能恢復進行中的求救；可更新、延長、標記已安全、取消。
- 終態與過期不顯示為進行中，也不畫在地圖上。
- marker 同時表達類型、急迫度、驗證；semantics 測試確認不依賴顏色。
- 警報：點擊後才播放；可停止、重播、60 秒自動停止；鎖屏與切換 App 後仍播放且可從通知停止；音量 0、焦點被拒、來電有正確狀態；dispose 後不殘留音訊；不改系統音量；飛航模式下可用（實機）。
- 線上同步：上傳狀態正確；下載的事件經驗章後才入庫並進入 mesh。

### Web

- 表單、marker、詳情、警報 UI 與 Android 共用 widget 測試。
- 警報只在使用者操作後啟動；`AudioContext` 被拒時顯示失敗；不承諾背景播放（Chrome 實測）。
- 送出：server 接受前顯示等待上傳；被拒不顯示成功；離線排隊、恢復後重試成功；不支援 Ed25519 時明確提示。
- `flutter build web` 成功。

### 指令

`flutter analyze`、Flutter focused 與完整 test、`gradlew testDebugUnitTest`、相關 instrumentation tests、`node --test pipeline/test server/test`、`flutter build web`、`gradlew assembleDebug`。實機與 Chrome 驗證若環境不允許，交付時列為人工驗證項目。

## 14. 實作順序

1. 契約：JS 與 Kotlin factory、validator、urgency 推導、套用規則、fixture（TDD）。
2. Android 資料層：repository、bridge、mesh dataset、保留上限、HazardOverlay 排除。
3. Server：POST／GET、儲存、速率限制；Azure bicep 與部署測試。
4. Web 簽章與 outbox（JS＋Dart 介面）。
5. Flutter 共用 UI：表單、確認頁、首頁卡片、marker、cluster、詳情、session 恢復，同時接上 Android 與 Web。
6. 警報聲：音檔產生、Android `LocatorSirenService`、Web `locator_siren.js`、`SirenController`。
7. Android 線上同步：上傳與下載。
8. 文件（data-contract、peer-sync、runbook、README）、完整測試、實機與 Chrome 驗收、PR。

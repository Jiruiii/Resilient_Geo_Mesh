# ResilientGeo Mesh v0 資料契約

這一版先固定資料邊界，讓 pipeline、Android 儲存層與 peer sync 可以各自開發。所有時間使用 RFC 3339 UTC；GeoJSON 座標使用 WGS84 `[longitude, latitude]`，缺值使用 JSON `null`，不以 `0` 代替。

## 資料產品邊界

| 資料產品 | 契約 | 用途 | 例子 |
| --- | --- | --- | --- |
| Dynamic Event | `event-v0`、`manifest-v0`、`chunk-v0` | 有發生時間、版本與 TTL 的動態狀態 | 道路封閉、地震、天氣警報、避難所開設狀態 |
| Static Feature | `feature-v0`、`layer-manifest-v0`、`layer-chunk-v0` | 可放在離線地圖上的靜態向量物件 | OSM 道路、避難所位置、醫院、災害潛勢區 |
| Static Raster | artifact metadata（後續版本定義） | 大型格網或影像檔 | DEM／DSM、SAR、光學影像 |
| Device Local Context | 不進共享資料封包 | Android 裝置本機即時資料 | GNSS／GPS 使用者位置 |

GNSS／GPS 不建立外部 Collector，不進入 Raw snapshot、Event、Feature 或 Peer Sync 封包。靜態 Feature 也不能為了沿用既有程式而假裝成 Event。

## 身分與版本

事件的邏輯鍵是 `(namespace, event_id)`，不是單獨的 `event_id`。因此 `official.tdx/road:382` 與 `crowd.community/road:382` 可以同時存在，群眾回報不會覆蓋官方事件。

`event_version` 是同一邏輯鍵的單調遞增版本。`source_version` 保留原始資料源的版本字串，不能拿來取代 `event_version` 的比較。

靜態 Feature 的邏輯鍵是 `(namespace, layer_id, feature_id)`。`dataset_id` 表示所屬資料集，`layer_id` 表示圖層，例如 `shelter`、`medical` 或 `osm-road`。來源特有欄位保存在 `properties`，不能提升成每個來源都必須實作的共同欄位。

Feature 的單筆來源版本保存在 `source_version`；整個靜態 layer 的單調版本保存在 Layer Manifest 的 `dataset_version`。收到較舊的 layer 版本時，不得覆蓋較新的本機版本。

## 完整性與簽章

`payload_hash` 是下列欄位組成的 canonical JSON（鍵名以 UTF-8 位元組排序、無空白）的 SHA-256：

```text
namespace, event_id, event_type, geometry, severity, source,
source_version, event_version, issued_at, expires_at, attributes
```

Feature 的 `payload_hash` 使用相同 canonical JSON 規則，覆蓋以下欄位：

```text
namespace, dataset_id, layer_id, feature_id, feature_type, geometry,
properties, source, source_version, issued_at, expires_at
```

簽章覆蓋 canonical payload 加上 `payload_hash`。v0 固定使用 Ed25519；私鑰只存在 pipeline／伺服器，不進 Android App。

Chunk 的 `chunk_hash` 覆蓋 canonical chunk content（dataset metadata、priority、encoding 與 events），不包含 `manifest_id`、`manifest_hash`、`byte_length` 與 signature envelope，避免 manifest hash 與 chunk hash 互相循環。Chunk signature 再覆蓋完整的 binding envelope；Manifest signature 覆蓋含 `manifest_hash` 但不含自身 signature 的內容。

`provenance.original_source`、`provenance.received_at` 與 `provenance.transport_source` 是傳播稽核資料，不參與 payload hash，也不能被 peer 改寫成原始來源。

## 群眾回報簽章（crowd.*）

民眾回報由手機自己簽章，不經過任何伺服器，因此不能依賴內建的 `trusted-keys.json`。做法是讓金鑰「自我證明」：

- 每台裝置第一次回報時產生自己的 Ed25519 金鑰（Android：Bouncy Castle 產生，種子以 Android Keystore 的 AES-GCM 金鑰加密後存在 app 私有目錄；私鑰不進 log、bridge 回傳值、HELLO 或事件）。
- 事件新增選填欄位 `signer_public_key`（base64 SPKI DER），並且 `signing_key_id = "device:" + sha256(SPKI DER) 的前 32 個 hex`。
- 驗證端（`pipeline/lib/contract.mjs` 的 `verifyEvent` 與 Android 的 `EventVerifier`，逐條對應）在 trust 階段分兩條路：
  - `signing_key_id` 以 `device:` 開頭：namespace 必須是 `crowd.*`，`signer_public_key` 必須是 Ed25519 SPKI，且指紋必須等於 key id；之後用這把公鑰驗章。
  - 其他 key id：維持原本規則，只接受內建信任清單中的金鑰。`device:` 金鑰永遠走不到這條路，所以加入群眾回報**不會**放寬 `official.*` 的信任規則；兩端都有反向測試釘住「裝置金鑰簽的 `official.*` 必須在 trust 階段被拒」。
- `signing_key_id` 以 `device:` 開頭但缺少 `signer_public_key`，在 schema 階段就被拒（`event-v0.schema.json` 以 `if/then` 表達）。
- 既有以內建 demo 金鑰簽章的 `crowd.*` fixture（`data/fixtures/neihu`、Android `signed-events.json`）仍然有效：規則以「金鑰種類」而不是 namespace 觸發，避免改寫所有既有 fixture。
- 同一 `(namespace, event_id)` 的較新版本必須由相同 `signing_key_id` 簽署，否則以 `signer_mismatch` 拒收；既有回報永遠是 v1，不受影響。

**裝置簽章證明什麼：** 內容從簽章後沒有被竄改；所有帶同一個 `device:` key id 的回報出自同一台裝置。**不證明什麼：** 回報內容屬實、回報者身分、或不同 key id 背後是不同的人。因此 crowd 事件一律以 `UNVERIFIED` 儲存與顯示，路線規劃也只把它當成加權、不當成封鎖。

回報事件格式（`pipeline/lib/crowd-report.mjs` 與 Android `CrowdReportFactory` 產出位元相同的結果，`fixtures/crowd-reports-v0.json` 釘住兩者）：

| 欄位 | 值 |
|---|---|
| `namespace` | `crowd.reports` |
| `event_id` | `report:<key id 後 8 碼>:<UUID>` |
| `event_type` | `CROWD_REPORT`，`geometry` 為 Point（座標取到小數點後 6 位） |
| `severity` | 依類別：`ROAD_BLOCKAGE` MEDIUM、`FLOOD` HIGH、`FIRE_SMOKE` HIGH、`TRAPPED_INJURED` CRITICAL、`OTHER` LOW |
| `expires_at` | `issued_at` + 6 小時 |
| `attributes` | `category`、`description`（trim 後最多 160 字元）、`location_source`（`CURRENT_LOCATION`／`MAP_PICK`）、選填 `location_hint`（本機搜尋索引的提示，不是權威地址）、`area_id: crowd`、`theme: report` |
| `provenance.transport_source.kind` | `local_report`（新增的 enum 值；轉傳時不改寫，因為 provenance 不在簽章範圍） |

座標必須落在台灣含離島的範圍（經度 116.5–122.5、緯度 20.5–26.8）。每台裝置同時最多 20 筆有效的自己的回報。

## 求救事件（crowd.rescue）

求救（「需要救援」）沿用群眾回報的裝置自我證明簽章，但是獨立的 namespace 與生命週期，不是 `crowd.reports` 的子類：

1. **識別**：`namespace = crowd.rescue`、`event_type = RESCUE_REQUEST`、`source = CROWD`、`source_version = rescue-request-v0`。`event_id` 格式為 `rescue:<32 碼 hex 指紋>:<小寫 UUID>`，指紋必須等於 `signing_key_id` 去掉 `device:` 前綴；兩者不一致時以 `rescue_event_id_unbound` 拒收。
2. **attributes**：僅允許 `request_type`（`FIRST_AID_NEEDED`／`IMMOBILE`／`TRAPPED`／`TRAPPED_DEBRIS`／`OTHER_RESCUE`）、`status`（`ACTIVE`／`RESOLVED`／`CANCELLED`）、`subject`（`SELF`／`OTHERS`；`SELF` 時 `triage.conscious` 必須是 `YES`）、`people_count`（整數 1–50）、`triage`（`immobile`／`breathing_difficulty`／`severe_bleeding`／`conscious`，值 `YES`／`NO`／`UNKNOWN`）、`description`（trim 後 ≤160 code points）、`location_source`、`location_hint`、`first_issued_at`、`area_id`、`theme`；出現清單以外的鍵以 `rescue_attributes_unknown` 拒收。
3. **urgency 推導**（`severity` 欄位即 urgency，人數不影響）：`request_type = TRAPPED_DEBRIS` → `CRITICAL`；`breathing_difficulty = YES` 或 `severe_bleeding = YES` 或 `conscious = NO` → `CRITICAL`；`request_type` 為 `TRAPPED`／`IMMOBILE` 或 `immobile = YES` → `HIGH`；其餘 → `MEDIUM`。求救沒有 `LOW`，與 `crowd.reports` 不同。
4. **TTL／延長**：`0 < expires_at - issued_at ≤ 6` 小時；延長後 `expires_at = min(now + 6h, first_issued_at + 72h)`；`expires_at ≤ first_issued_at + 72h`；`first_issued_at ≤ issued_at`；v1 時兩者相等，之後的修訂版本不可再變動 `first_issued_at`。超過上限分別以 `rescue_ttl_too_long`／`rescue_lifetime_exceeded`／`rescue_first_issued_changed` 拒收。
5. **驗證階段**：schema → trust → integrity → signature → **contract**（`crowd.rescue` 專屬檢查，錯誤 `stage` 固定為 `contract`）。常見錯誤代碼：`rescue_field_invalid:<欄位>`、`rescue_geometry_invalid`、`rescue_identity_invalid`、`rescue_event_id_unbound`、`rescue_attributes_unknown`、`rescue_severity_mismatch`、`rescue_version_too_high`、`rescue_time_invalid`、`rescue_ttl_too_long`、`rescue_lifetime_exceeded`、`rescue_terminal`、`rescue_terminal_expiry_changed`、`rescue_first_issued_changed`。
6. **套用規則**：同一 `(namespace, event_id)` 的任何 `crowd.*`（含 `crowd.reports` 與 `crowd.rescue`）新版本都必須由相同 `signing_key_id` 簽署，否則以 `signer_mismatch` 拒收（見下節）。`crowd.rescue` 終態（`RESOLVED`／`CANCELLED`）之後不接受任何新版本（`rescue_terminal`）；終態沿用前一版 `expires_at`，若新版本改動則以 `rescue_terminal_expiry_changed` 拒收；`first_issued_at` 一旦寫入即不可變；`event_version` 上限 200（`rescue_version_too_high`）。
7. **轉傳單位**：上傳、儲存、下載與 mesh 轉傳的單位一律是「原裝置簽章的 crowd-rescue chunk」；`dataset_id = crowd-rescue`、`manifest_id = crowd-rescue:none`、`chunk_id = crowd-rescue:<event_id>`、`area_id = crowd`、`theme = rescue`。伺服器與中繼節點都原樣保存與轉發，不重簽、不改寫。
8. **三端實作與共用 fixture**：JS `pipeline/lib/rescue-contract.mjs`、`pipeline/lib/rescue-request.mjs`；Android `trust/RescueContract.kt`、`report/RescueRequestFactory.kt`；Web `flutter/web/rescue_outbox.js`；三端位元相同的輸出由 `fixtures/rescue-requests-v0.json` 鎖定。

## 官方查證事件（official.verified）

政府查證是一筆獨立的官方事件，**不修改**原回報：

- `namespace = official.verified`，`event_id = attest:<原回報 event_id>`，`event_type = ATTESTATION`，`geometry` 複製原回報。
- `attributes`：`target_namespace`、`target_event_id`、`target_event_version`、`target_payload_hash`、`target_signing_key_id`、`verdict`（`CONFIRMED`／`REFUTED`）、選填 `note`。
- `expires_at` 等於原回報的 `expires_at`；已過期的回報不能被查證。
- 以官方金鑰簽章（必須在手機的 `trusted-keys.json` 裡），走既有的 `build` → 分片 → mesh 下行路徑。
- 改判：對同一筆回報再次 attest 時 `event_version` 遞增，一般的「新版本覆蓋舊版本」規則就會生效。
- 手機端（Flutter `attestation_index.dart`）只在確認事件本身仍有效、`target_payload_hash` 等於回報的 `payload_hash`、且 namespace 確實是 `official.verified` 時套用；多筆時取 `event_version` 最高者。Android 的 `ApplyState` 不因此改變。
- 產生方式：`node pipeline/cli.mjs attest --report <匯出檔> --verdict CONFIRMED --private-key <pem> --key-id <官方 key id>`。

## 地區與主題（area_id / theme）

每筆事件用 `attributes.area_id`（生活圈，例 `neihu.donghu`）與 `attributes.theme`（`road`、`shelter`、`flood`、`landslide`、`medical`、`transit`）標記它屬於哪個地理與主題切片。這兩個欄位刻意放在 `attributes` 內，理由是：

1. `attributes` 已在簽章的 canonical payload 內（`payload_hash` 涵蓋範圍），所以來源一旦簽了，就不能被 peer 改動 area/theme 而不被偵測。
2. `event-v0.schema.json` 的 `attributes` 是 `additionalProperties: true`，不必動 schema。

**Chunk 與 manifest 另外顯式帶一份 `area_id`／`theme`／`bbox`**（兩份 schema 為此新增必填欄位）：

- `chunk_hash` 的 canonical content 納入 `area_id`、`theme`、`bbox`，所以竄改分片宣稱的區域會讓 chunk hash 對不上。
- `manifest.chunks[]` 每個條目也帶這三欄，讓節點**不下載 chunk 就能判斷該片是否與自己所在區域相交**。
- `bbox` 一律 `[minLon, minLat, maxLon, maxLat]`，由分片內所有事件幾何推導（不手填）。接收端 `verifyChunk()` 會重算並比對，不符時回 `stage: 'integrity'`、`chunk_bbox_mismatch`。

事件層的 `area_id` 隨事件簽章移動；chunk 層的 `area_id` 隨 chunk hash 固定——兩者都不可由中繼節點改寫。

`issued_at` 是來源資料或 snapshot 的發布時間；`expires_at` 是接收端應停止把該資料視為目前版本的時間。靜態資料沒有官方失效時間時，由 source catalog 的 `ttl_policy` 決定更新期限，不能假裝成即時 API。

本目錄的 fixture 使用穩定的測試 hash／signature token，供 schema 與狀態轉移測試使用；它們不是正式信任根。正式 pipeline 接上 Ed25519 後，必須以實際 hash 與簽章取代。

## 套用順序

接收端依序執行：

1. 解析 schema；格式錯誤直接拒絕。
2. 驗證 manifest／chunk hash，再驗證每個 Event 的 payload hash 與 Ed25519 signature。
3. 以 `(namespace, event_id)` 查詢本機版本；較舊或相同版本不覆蓋目前事件。
4. 較新版本以原子交易寫入，並保留接收與傳輸 provenance。
5. 顯示時以 `evaluation_time >= expires_at` 判定 expired；過期資料可留在 cache，但不能標示為目前有效。

`fixtures/expected-results-v0.json` 是上述規則的可重播預期結果。

## 靜態 Layer 封包

`layer-manifest-v0` 是一個靜態向量圖層版本的簽章索引，至少包含：

- `dataset_id`、`layer_id`、`namespace` 與 `dataset_version`。
- `source`、`source_version`、`created_at` 與 `expires_at`。
- `total_feature_count`、`total_size_bytes` 與 chunk 清單。
- `bbox`（由所有 Feature 幾何推導）與 `content_hash`（所有 Feature payload 的 canonical hash）。
- Manifest hash、Ed25519 signature 與 `signing_key_id`。

`layer-chunk-v0` 是實際傳輸單位，使用 `features` 裝載 `feature-v0`，不能使用動態事件 Chunk 的 `events` 欄位。每個 chunk 必須綁定已驗證的 Layer Manifest，並驗證 `manifest_hash`、`chunk_hash`、大小、筆數與簽章。

靜態 Layer 的接收順序為：

1. 驗證 Layer Manifest schema、hash、簽章與信任金鑰。
2. 比較 `(namespace, dataset_id, layer_id)` 的本機 `dataset_version`，拒絕版本倒退。
3. 只要求本機缺少的 Layer Chunk。
4. 驗證 Chunk 與 Manifest binding，再驗證每筆 Feature。
5. 全部必要 Chunk 驗證成功後，以原子方式切換到新的 layer 版本。

避難所是靜態位置與動態狀態的分層例外：名稱、地址、容量、適用災害類別
進入 `feature-v0`；開設中、額滿、關閉等狀態進入獨立的
`SHELTER_STATUS` `event-v0`，不把會變動的狀態簽進靜態位置 Feature。

Android 端每個 layer 驗證通過後，會以「信任清單、manifest、所有 chunk 的原始位元組」算出的
SHA-256 為鍵，把驗證後的 Feature 快取在 app 私有目錄（`VerifiedLayerCache`）。任何一個位元組或
信任金鑰改變，快取就失效並重新完整驗證；驗證失敗仍然 fail closed。這讓全台避難所圖層
（5,907 筆）不必每次啟動都重驗全部簽章。

## Static Raster／Network Artifact Metadata

Task 6 的 `pipeline/sources/raster-catalog.json` 是來源與 artifact metadata
註冊，不代表檔案已經下載到 repository。每一筆資料都要標示來源 owner、
官方 URL 或申請路徑、格式、CRS、WGS84 bbox、時間範圍、更新模式、存取限制、
原始／衍生界線、用途與 limitation。

目前三筆 advanced source 都是 `artifact_status=metadata_only`，因此
`file_hash` 明確為 `null`；實際下載檔案後才可填入該檔案的 SHA-256。這避免
用 metadata hash 冒充原始 raster 或影像檔 hash。`network-neihu` 是區級基地臺
統計表，bbox 只代表內湖適用範圍，不代表基地臺點位或訊號覆蓋。

A 只提供來源 metadata、原始檔案（若取得）與 provenance；坡度、孤立風險、
通訊脆弱度、淹水範圍、崩塌判釋與災損分類由 D 或後續分析流程負責，且必須
另外標示為 derived output。

## Source catalog 與 Raw 的關係

`pipeline/sources/catalog.json` 只登記來源入口、存取模式、授權、更新頻率、座標系統、TTL 與內湖過濾方法，不保存 API key，也不是原始資料快照。

Task 2 才會定義 `raw-snapshot-v0`。Collector 必須先保存未篩選的原始回應，再建立內湖區正規化輸出；Collector 只做取得、保存、區域篩選、欄位正規化與品質驗證，不計算坡度風險、孤立風險、避難指標或路線。

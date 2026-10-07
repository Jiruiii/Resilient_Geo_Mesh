# 醫療院所部分定位資料發布 Spec

## 目的

讓手機和 Web 能下載目前已通過來源、座標、縣市與身分檢查的醫療院所點位，不必等待全台每筆名冊都定位完成。缺少座標或機構身分有歧義的項目保留在醫療名錄中，但不生成地圖座標。

本規格只調整醫療資料的收集可觀測性與發布條件，沿用現有 Ed25519 靜態圖層、manifest、chunk、API 路徑及用戶端信任金鑰。

## 已確認需求

- 可先發布部分已定位院所；API 必須標示 `partial` 並回報同輪實際數量。
- `taiwan-medical` 地圖層只收錄座標來源可信、座標及縣市有效、機構代碼唯一的院所。
- `nearby_address_candidate` 這類多個官方門牌候選間的近似選擇不視為已驗證點位，保留在 directory 並以 `unverified_coordinate_match` 回報；只對機構代碼與原始地址均符合審核規則的 `reviewed_address_correction` 接受點位。
- 未定位院所可留在 `taiwan-medical-directory`，`geometry` 必須為 `null`，不得在地圖產生 marker。
- 重複機構代碼的資料在確認身分前不進入地圖點位層，不可只依代碼自動合併。
- Web 與 Flutter Android 必須在同一批次接收並驗證新版資料。
- 本次目標是本機 API 可提供新版資料；不包含正式環境部署或把完整資料預先打包進新 APK/Web build。

## 現況與根因

2026-10-06 的稽核報告列出 24,138 筆名冊列、21,749 筆已定位、2,389 筆未定位；另列 114 組重複機構代碼，以及 96 組重複點位 ID。21,749 是已定位列數，不代表排除重複身分後可安全發布的唯一點位數；最終點位數須以同輪身分稽核結果為準。

目前 `medical-release-policy.mjs` 將發布條件限定為名冊全數定位、代碼唯一、縣市完整，且 directory 全數連至點位。`collector-runner.mjs` 將未通過的醫療結果當作 source failure，只更新來源狀態，不呼叫發布器，因此保留舊圖層。

Collector 啟動時會等待初始收集結束後才輸出完成摘要；醫療收集會呼叫 NLSC 查詢網格。`up -d` 只回報容器啟動，緊接著查 manifest 會讀到上一個已發布版本。規格要求 collector 記錄醫療來源開始、查詢進度與結束摘要，且不得記錄院所個資或完整座標。

目前 API 的舊醫療 manifest 有 747 個 chunks，而 Web 與 Android 各自限制最多 512 個。新發布器已將新 layer 的 chunk 目標大小設為 256 KiB；每次新發布都必須以產出 manifest 確認 chunk 數在用戶端上限內，不調高用戶端上限來遷就舊 bundle。

## 發布契約

### 計數與狀態

同一輪結果必須能對帳：

```text
source_count = published_matched_count + unresolved_count + excluded_count
```

- `source_count` 是同一來源版本成功解析出的名冊列數；每列在本輪只能歸入以下三類之一。
- `matched_count` 必須等於實際簽入 `taiwan-medical` 的唯一安全點位數，不能沿用尚未過身分檢查的定位候選數。
- `unresolved_count` 是仍保留在 directory、但沒有地圖點位的列數；包含無可接受座標及暫時無法確認身分的列。重複機構代碼的群組列全部歸在這一類，即使其中部分列原本有座標。
- `excluded_count` 是可安全保留名錄、但不能進點位層的列數（例如座標落在台灣範圍外），以 `geometry_status=excluded`、`geometry=null`、`point_feature_id=null` 表示，並提供彙總原因。無法解析的整體來源、無法可靠計數或缺少建立名錄項目所需身分的列屬收集失敗，不得用 excluded 掩蓋。
- directory 保留本輪每一筆成功解析的名冊列：`directory.total_feature_count = source_count = matched_count + unresolved_count + excluded_count`。
- API 除了 unresolved reason counts，還須回報 `duplicate_institution_code_group_count`、`duplicate_institution_code_affected_row_count`、`duplicate_institution_code_extra_row_count`，以及對應的 `duplicate_point_id_*` 欄位；不能只靠 `status` 表示重複情形。
- `status=partial` 表示名冊本身已成功取得、解析並完成計數，本輪合法子集已驗證發布，但有未定位、身分歧義、excluded 列或座標候選查詢失敗。
- `roster_complete` 必須為 `true` 才能發布；若上游明確標示名冊回應不完整，即使當中有安全點位也保留上一版。
- 上游名冊無法取得、資料格式錯誤、簽章/雜湊失敗或無法證明計數一致時，不發布新 layer，保留 last-known-good layer，來源狀態回報實際錯誤。

### 地圖點位層

`taiwan-medical` 只包含以下資料：

- 來自已核准政府座標來源或已驗章官方門牌包。
- 通過 WGS84 範圍、行政區縣市、來源版本與配對方法檢查。
- 機構代碼唯一，且 `feature_id` 唯一。
- 點位數與本輪 `matched_count` 相同。

同一機構代碼出現多列時，在稽核確認前不發布該歧義群組的點位。不得猜測哪一列正確，也不得把不同名稱、地址或座標的列靜默合併。精確可發布點位數可以低於 21,749。

### 醫療名錄層

`taiwan-medical-directory` 保留本輪名冊項目作搜尋用途：

- 已定位且有唯一點位者，使用 `geometry_status=located` 並連到唯一 `point_feature_id`。
- 未定位或身分有歧義者使用 `geometry_status=unresolved`、`geometry=null`、`point_feature_id=null`，並提供原因；可安全保留但不屬台灣點位範圍者使用 `geometry_status=excluded` 且同樣不得連到點位。
- directory feature ID 必須唯一；重複機構代碼的名錄列可保留，但不得因此產生重複地圖點位。Feature ID 不可只用可能重複的機構代碼生成；應使用來源列 ID，若來源沒有列 ID，則使用穩定且可重現的列識別值，並明確不把它當成院所身分判定。
- 名錄中的未定位項目可供文字搜尋，但地圖不得替它們建立 marker 或推算座標。

### 發布與相容性

- 經過資料品質檢查的 partial 醫療結果可進入 publisher；一般上游失敗或 bundle 驗證失敗仍保留舊發布。
- 醫療點位層與名錄層使用同一來源版本及同輪計數，經簽章、hash 與關聯檢查後由單一 release-pointer 更新同時切換；成功 source status 在 pointer 更新後以該輪版本與計數發布。若發布失敗，source status 可記錄失敗，但兩個 layer 仍指向 last-known-good。
- 沿用現有 layer ID、feature schema、Ed25519 manifest/chunk 格式及下載 API。
- 每個 layer 的 chunk 數須不超過 512；優先沿用新發布器的 256 KiB chunk 目標。若實際產物仍超限，先調整伺服器端分塊，不直接提高 Web/Android 上限。
- Web 與 Android 都要載入相同的新版 manifest hash/dataset version；地圖只顯示 `taiwan-medical` 的安全點位。Directory 項目沒有 geometry 時保持無 marker。

## 範圍外

- 本規格不改醫療院所主檔或座標來源授權。
- 不以 OSM、道路中點、地址近似或手填座標補點。
- 不把未定位院所標示為完整或已定位。
- 不在本批次製作 Android 離線內建基線；Server 線上更新與冷安裝離線基線仍是分開的工作。
- 不更動避難所或動態資料發布規則。

## 驗收條件

1. 同輪 `source_count`、`matched_count`、`unresolved_count`、`excluded_count` 與重複身分彙總可對帳，`status=partial` 清楚可見。
2. `taiwan-medical` manifest 的 `total_feature_count` 等於實際唯一安全點位數；所有點位來源、座標、縣市與 feature ID 均通過既有驗證。
3. directory 保留本輪全部可解析名冊列；located 項目各連至一個有效點位，unresolved/身分歧義/excluded 項目均為 null geometry 且沒有 point link。
4. 新 manifest/chunks 的 Ed25519、hash、版本及 feature 數驗證通過；每層 chunks 不超過 512。
5. 本機 API 的 `taiwan-medical` 與 `taiwan-medical-directory` 回傳新版；Web 和 Flutter Android 載入相同 manifest hash/version，地圖只顯示可驗證點位。
6. 收集或發布發生失敗時，手機與 Web 仍能使用上一個有效 layer，不被空資料或未簽章資料覆蓋。

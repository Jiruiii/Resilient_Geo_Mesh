# 醫療院所定位補齊與 App 離線內建實作計畫

> **狀態更新（2026-10-07）：** 線上 Server 發布規則已由「全數定位才發布」改為安全 partial 發布，依據 [醫療院所部分定位資料發布規格](../specs/2026-10-07-medical-partial-release-design.md) 與[線上發布實作計畫](2026-10-07-medical-partial-release-implementation.md)。舊計畫 Task 4 的 `unresolved_count=0` 全數定位 gate 不再適用於 Server 線上發布；本次不包含 Task 5–8 的 Android/Web 內建離線基線工作。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 將 2026-10-04 清單中 23,659 筆未定位院所用可核實座標補齊，並讓新安裝的 Android App 離線即可顯示完整醫療圖層；Server 後續提供已簽章更新，Web 與 Flutter Android 使用相同資料版本。

**Architecture:** MOHW 院所主檔維持名冊來源；collector 以 NLSC 院所候選和已驗章門牌資料配對，並只加入有官方來源、縣市相符且結果唯一的座標。正式醫療圖層維持既有簽章 manifest/chunk 契約；同一份簽章基線隨 Android/Web 版本發佈，客戶端先用內建基線，成功驗證較新版 Server bundle 後再更新本機快取。

**Tech Stack:** Node.js ESM、既有 pipeline collector 與 Ed25519 layer bundle、Kotlin/Android AssetManager、Flutter/Dart、Flutter Web JavaScript loader、現有 Node/Flutter/Gradle 測試工具。

**Spec:** 2026-10-05 對話確認的需求；資料基準與目前限制見[全台資料涵蓋報告](../../data-coverage-2026-10-04.md)及[底圖與國家資料說明](../../data_description.md)。

## Global Constraints

- 只使用授權清楚且可追溯的政府座標資料；OSM 道路中點、未核實模糊結果及手填座標不得當成已定位院所。
- 只有通過機構識別、完整正規化地址、縣市界線、WGS84 座標範圍和唯一性檢查的候選才能進 `taiwan-medical` 點位圖層。
- 每個定位結果保留座標來源、來源版本及配對方法；歧義或缺來源的資料保留原因，不得假報為已全部定位。
- 成功標準以同一輪 MOHW 名冊為準：全部院所可由唯一機構代碼對帳，目標 `unresolved_count=0`；達不到時停止完整發布並列出未解數量及原因。
- Android、Flutter Web 與 Server 沿用現有簽章、manifest/chunk、信任金鑰及來源狀態契約；不得把私鑰放入 App、Web build、日誌或版本控制。
- Android 冷安裝且尚未連線時可驗證並載入內建醫療基線；Web 發佈物包含相同基線，瀏覽器離線使用以 Web shell 已下載/快取為前提。
- 保留工作樹既有 WIP；不執行 `git add`、commit、push 或正式環境部署。

## Review Focus

- 同地址多院所或同一門牌多個官方點位：保留機構識別及縣市檢查；同一正規化門牌的候選點仍需符合 100 公尺界線，否則留為歧義；由 matcher 測試涵蓋。
- 全半形、行政區前綴、樓層及地址別名差異：只允許明確的正規化/來源別名規則，不能用道路名或門牌號部分相似配對；由 address-pack 測試涵蓋。
- 缺少縣市門牌包、來源中斷或來源授權變更：保持未定位並回報 source status，不沿用舊數字當成本輪結果；由 source collector/publisher 測試涵蓋。
- Server 更新簽章錯誤、過期或下載中斷：保留內建或上一個已驗證 bundle；由 Android/Web bundle loader 測試涵蓋。
- 內建 bundle 與 Server 更新不同版本或 chunk：不得混用 manifest/chunks；由跨平台 manifest/hash parity 驗收涵蓋。

---

### Task 1: 建立本輪未定位原因與官方來源覆蓋稽核

**Files:**
- Create: `pipeline/tools/audit-unresolved-medical.mjs`
- Create: `pipeline/test/medical-unresolved-audit.test.mjs`
- Create: `docs/medical-unresolved-audit.md`（只存彙總數字、來源及原因，不複製整份院所名冊）
- Reference: `pipeline/lib/source-collector.mjs`、`pipeline/sources/medical.mjs`、`deploy/public/address-packs/catalog.json`

**Interfaces:** 工具讀取本輪 collector 輸出的 unresolved medical JSON、座標報告及簽章門牌 catalog；以機構代碼為 key，輸出各 unresolved reason、縣市、地址欄位完整度、候選來源與唯一/重複匹配數的彙總 JSON/Markdown。缺少輸入欄位或重複機構代碼時以非零狀態結束。

- [x] 先新增測試，驗證原因與縣市分組、唯一機構代碼對帳、重複代碼拒絕、缺輸入拒絕。
- [x] 執行 `node --test pipeline/test/medical-unresolved-audit.test.mjs`，確認新增案例先失敗。
- [x] 實作 audit 工具；只讀本輪真實 collector 輸出，不把 fixture 或 2026-10-04 舊數字冒充成新結果。
- [x] 以新一輪 MOHW + NLSC + 現有簽章門牌包產生彙總報告；標出各縣市缺少可用官方門牌來源的數量。
- [x] 重跑該測試並核對輸出總數：`located + unresolved = 本輪 MOHW 名冊總數`；`rejected_coordinate_count` 獨立統計候選座標，不重複計入院所列數。

### Task 2: 補足並驗證可用的官方地址座標來源

**Files:**
- Modify as source audit requires: `pipeline/sources/address-pack-sources.mjs`、`pipeline/lib/address-packs.mjs`、`pipeline/sources/catalog.json`
- Modify as source audit requires: `pipeline/test/address-packs.test.mjs`、`pipeline/test/static-sources.test.mjs`
- Reference: `deploy/public/address-packs/catalog.json`、`data_description.md`

**Interfaces:** 每個新增縣市來源須明列官方 URL、授權、來源版本、原座標系統、欄位映射及縣市代碼；透過既有地址包產製流程輸出通過簽章/雜湊/逐筆縣界驗證的 pack。若需要申請型 API，必須先有核准與正式介接規格；沒有來源授權或資料存取權時停在來源缺口報告，不建立猜測 adapter。

- [x] 依 Task 1 的縣市缺口，確認可使用的官方門牌/院所座標來源與授權，記錄其版本及欄位/CRS。
- [x] 先為已選定來源新增 parser/CRS/縣界/重複資料測試，含缺座標、非法座標和跨縣資料拒絕。
- [x] 以既有 pack builder 匯入來源並更新 coverage catalog；簽署使用既有 secret-managed key，私鑰不得新增至 repo。
- [x] 驗證 catalog/manifest 簽章、pack SHA-256、located/source counts 與每筆座標縣界；只有 `complete` 或明確 `partial` 的真實狀態可寫入 catalog。
- [x] 重跑 `node --test pipeline/test/address-packs.test.mjs pipeline/test/static-sources.test.mjs`。

### Task 3: 修正精確門牌候選索引與院所配對

**Files:**
- Modify: `pipeline/lib/address-pack-reader.mjs`
- Modify: `pipeline/sources/medical.mjs`
- Modify: `pipeline/lib/source-collector.mjs`
- Test: `pipeline/test/address-packs.test.mjs`
- Test: `pipeline/test/taiwan-sources.test.mjs`
- Test: `pipeline/test/source-collector.test.mjs`

**Interfaces:** 門牌 reader 為每筆官方記錄建立縣市限定的 normalized full-address key，涵蓋來源明列的 `address` 與 `aliases`，輸出座標來源、版本、pack county 及可供院所 matcher 核對的 matched key。`mergeMedicalCoordinates` 按 institution code 優先、完整地址/縣市匹配其次；比對時將段、巷、弄、號及樓層等地址結構中的國字數值轉為阿拉伯數字，忽略樓層與單位註記，並把門牌之號/連字號子號歸到主號。院所地址欄列出多個門牌或多個地址時，一律只使用第一個門牌；若第一個沒有官方候選，維持未定位，不改選後續地址。同一個正規化門牌若有多筆官方座標，仍須符合 100 公尺界線才採第一筆，超出則列歧異。

- [x] 新增回歸測試：地址別名（含全半形號碼及有/無樓層的明確 alias）能匹配；只同道路或門牌號相似不能匹配；跨縣候選拒絕。
- [x] 新增多候選測試：重複候選座標相同時唯一化，座標不同時保留 `multiple_candidates`。
- [x] 執行上述三個 Node targeted test files，確認新增測試先失敗。
- [x] 實作 reader 的 alias 索引與 matcher 的唯一性處理；不改變機構代碼的優先匹配規則及原始名冊欄位。
- [x] 每筆補定位 feature 輸出 `coordinate_source`、`coordinate_source_version` 與 `coordinate_match_method`；source status 彙總各方法命中數及 unresolved 原因。
- [x] 重跑上述 targeted tests，確認舊有 NLSC 配對、無效座標拒絕與未定位保留行為都通過。

#### 2026-10-06 使用者規則更新

- 地址欄有多個門牌或多個完整地址時，統一取第一個門牌；不比較後續地址的距離，也不因第一個缺候選而改選第二個。
- 地址結構欄位（段、巷、弄、號、樓）的中文數字與中英數混寫一律轉成阿拉伯數字（如 `二四一巷二弄5號`、`五七0號`、`一二 0號`）；樓層範圍、樓層之號、棟別/區域及門牌後的子號附註不併入主門牌 key。
- 只對同一正規化主門牌的多個官方座標保留 100 公尺唯一性檢查。

### Task 4: 以同一輪官方資料產製完整簽章醫療圖層

**Files:**
- Modify: `pipeline/lib/source-collector.mjs`
- Modify: `server/src/collector-entrypoint.mjs`
- Modify: `server/src/publisher/release-publisher.mjs`
- Test: `pipeline/test/source-collector.test.mjs`
- Test: `server/test/release-publisher.test.mjs`

**Interfaces:** 一次收集結果包含 `taiwan-medical` 地圖點位、`taiwan-medical-directory` 名錄及同輪座標報告。兩層共用該輪來源版本；未定位項目可留在名錄但不得生成虛構 geometry。完整發布條件為名冊代碼皆唯一且 `unresolved_count=0`；被拒絕的候選座標不得進圖層，但其數量獨立回報，不要求無關候選的 rejected 數為零。失敗時 source status 保留本輪真實計數且不替換 last-known-good release。

- [x] 新增測試：所有 24,138（或本輪實際名冊數）記錄各有一筆可對帳點位時產生可發布結果；有未定位、代碼重複或候選歧義時不可標示 complete。
- [x] 新增 publisher 測試：配對未達 complete 時保留舊 layer，source status 回報本輪 matched/unresolved/reason counts。
- [x] 執行 `node --test pipeline/test/source-collector.test.mjs server/test/release-publisher.test.mjs`，確認新增測試先失敗。
- [ ] 更新 collector/publisher 將已驗證完整的同輪資料建成簽章 `taiwan-medical` 與 `taiwan-medical-directory` bundle。
- [ ] 以受信任公開金鑰驗證 manifest、所有 chunks、機構代碼唯一性、features 數量、座標範圍及行政區界線；不部署正式 Server。
- [ ] 重跑 targeted tests 並保存 bundle manifest/hash、source status 與計數作為後續打包輸入。

### Task 5: 將簽章基線打包進 Android 與 Flutter Web 發佈物

**Files:**
- Create: `pipeline/tools/package-medical-app-baseline.mjs`
- Create: `pipeline/test/package-medical-app-baseline.test.mjs`
- Modify: `package.json`
- Modify: `android/app/src/main/assets/static/`（由已驗證 manifest/chunks 產生醫療基線）
- Modify: `flutter/web/`（將相同 manifest/chunks 納入 Web 發佈物）
- Modify: `flutter/pubspec.yaml`（如 Flutter Web bundle 需明列 asset）

**Interfaces:** `package-medical-app-baseline.mjs --release-dir <verified-layer-release> --android-assets <dir> --web-assets <dir>` 只接受 Task 4 已產出的非空完整簽章 `taiwan-medical` 與 directory bundle；複製 manifest/chunks 時逐一驗證層 ID、manifest hash、chunk hash 和總 feature 數，不重簽或改寫簽章內容。Android 與 Web 的輸出 manifest hash 必須一致。

- [ ] 新增測試：無簽章、過期/不完整 chunk、manifest 與 layer ID 不符、unresolved 不為 0 時拒絕打包；合法輸出兩個目標目錄的 manifest/hash 相同。
- [ ] 執行 `node --test pipeline/test/package-medical-app-baseline.test.mjs`，確認新增測試先失敗。
- [ ] 實作打包工具及 npm script；產物只來自 Task 4 的驗證 release，不複製 private data 或簽章私鑰。
- [ ] 產生 Android 與 Web 基線 asset，檢查 APK/Web build 的檔案總大小並記錄實測值。
- [ ] 重跑打包測試及 `git diff --check`。

### Task 6: Android 首次離線讀取基線並保留 Server 更新

**Files:**
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/MeshRepository.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/StaticLayerBundleCache.kt`
- Test: `android/app/src/androidTest/java/com/resilientgeo/mesh/data/StaticLayerInstrumentedTest.kt`
- Test: `android/app/src/test/java/com/resilientgeo/mesh/data/StaticLayerBundleCacheTest.kt`

**Interfaces:** layer fallback 順序為有效的 Server download、已驗證本機 cache、簽章有效的 App 內建基線。線上下載須通過 expiry/hash/signature；任何更新失敗都不得覆蓋可用的 cache 或內建基線。內建基線依離線 snapshot 規則驗章並保留來源日期；不得因沒有網路而回空醫療層。

- [ ] 新增 instrumentation 測試：清空 App 私有 cache、阻斷網路後首次啟動，從 packaged assets 驗章並載入所有醫療點和名錄；不能通過舊 cache 假成功。
- [ ] 新增 instrumentation 測試：Server 發布更新後下載並驗章、寫入 cache；強制停止、斷網冷啟動後仍載入同版完整資料。
- [ ] 新增回歸測試：不可信/損毀更新不取代有效基線；directory geometry 仍連到對應 medical point。
- [ ] 執行 `./gradlew :app:testDebugUnitTest` 與 `./gradlew :app:connectedDebugAndroidTest --tests '*StaticLayerInstrumentedTest'`。
- [ ] 確認 API 36 模擬器乾淨安裝、飛航模式啟動、上線更新、再離線冷啟動四階段的 manifest hash 與 feature counts 相符。

### Task 7: Flutter Web 讀取同一簽章基線並同步 Server 更新

**Files:**
- Modify: `flutter/web/nlsc_static_layers.js`
- Modify: `pipeline/test/nlsc-static-layers-web.test.mjs`
- Modify: `flutter/test/map_layers_test.dart`（如需驗證顯示狀態）

**Interfaces:** Web loader 在同源 Server bundle 失敗時，先使用已驗證 cache，再使用同一版 Web build 內建基線；成功下載完整有效新版後才原子更新本機 bundle。醫療點和名錄仍採現有 layer ID、feature schema、簽章 verifier 與 MapLayers 投影流程。

- [ ] 新增 Web loader 測試：乾淨 browser storage、Server 離線時讀取 packaged baseline；線上較新版能取代舊 cache；壞簽章、chunk 不完整或下載中斷時仍顯示上一版。
- [ ] 執行 `node --test pipeline/test/nlsc-static-layers-web.test.mjs`，確認新增測試先失敗。
- [ ] 實作 bundle 選擇與原子快取更新，保持 Android/Web 共用相同 manifest hash。
- [ ] 重跑測試及 `flutter test`、`flutter analyze --no-pub`、`flutter build web --release`；只以 Web shell 已經下載/快取後的離線狀態驗收。

### Task 8: 雙端完整資料對帳與交付紀錄

**Files:**
- Modify: `docs/data-coverage-2026-10-04.md` 或新增本輪 `docs/medical-coordinate-coverage-YYYY-MM-DD.md`
- Modify: `pipeline/README.md`
- Reference: Android/Web 內建 bundle 與 Server 發布 bundle

- [ ] 以同一輪官方快照核對 MOHW 唯一機構代碼總數、located/unresolved totals、獨立的 rejected-candidate count、各座標來源/配對方法及各縣市 counts；完成條件為 `unresolved=0`，所有 rejected 座標均未被發布。
- [ ] 比較 Android asset、Web asset、Server release 的 layer IDs、manifest hash、chunk counts 與 feature counts，確認逐一一致。
- [ ] Web 瀏覽器完成初次載入後切離線，驗證醫療點、名錄與詳情；Android API 36 模擬器以乾淨安裝/快取完成離線基線及 Server 更新流程。
- [ ] 若要求正式 Server 驗收，另行以正式 HTTPS 最新 source status、manifest/chunks 及實機證據驗證；本計畫的本機 build 不代表正式部署。
- [ ] 更新資料來源、授權、資料日期、已定位數、App 內建版本及更新方式文件；不得把本機證據描述成已正式發布。
- [ ] 保留所有工作樹變更，不 add/commit/push。

## 完成判準

同一輪 MOHW 名冊的 23,659 筆原未定位紀錄均有可追溯且唯一通過核對的座標；`taiwan-medical` 與 directory 的 signed bundle 皆完整且有效；Android 新安裝離線可顯示內建全台資料，Android/Web 可下載並快取同一個 Server 簽章新版，更新失敗時保留上一版。任何來源缺口或 ambiguous records 都代表完整目標尚未達成，必須逐項列出而不能以估算點位補足。

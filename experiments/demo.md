# Demo 腳本

第 1–4 節用模擬器，不需要實機，展示「只交換彼此缺少的分片」與三種策略的差異，約 5 分鐘。第 5–6 節是民眾回報與逃生路線，需要實機（debug build）。

## 0. 前置

```
npm test            # 全綠（pipeline + simulator）
```

## 1. 單機基準：無協作

```
node simulator/cli.mjs run --nodes 50 --strategy no-coop --seed 20260904 --out .sim-out
```

指出摘要裡 `coverage_final ≈ 0.65`、`cellular_savings = 0`。
說明：50 台手機各自從 server 拉，12 分鐘內誰都沒抓完，也沒有任何流量節省。

## 2. 加上 peer sync

```
node simulator/cli.mjs run --nodes 50 --strategy replication --seed 20260904 --out .sim-out
node simulator/cli.mjs run --nodes 50 --strategy rarest-first --seed 20260904 --out .sim-out
```

`coverage_final ≈ 1.0`、`cellular_savings ≈ 0.86–0.87`、`transfer_efficiency ≈ 0.60–0.63`。
說明：只有 gateway 還在用行動網路，其餘節點靠 P2P 補齊；~87% 的位元組不再向 server 要。
rarest-first 比 replication 省更多、重複傳輸更少。

## 3. 地理相關性過濾

```
node simulator/cli.mjs run --nodes 50 --strategy rarest-first --seed 20260904 --geo-filter --out .sim-out
```

`coverage_relevant_final ≈ 1.0`、`cellular_total_vs_full ≈ 0.91–0.92`、`freshness_p50_seconds` 降到 ~120。
說明：住西湖的節點不去抓大湖山莊的土石流分片，但全區級淹水警報仍然收得到。相對「每台
下載整份資料集」省了 ~90%。

## 4. 全矩陣與報告

```
node simulator/cli.mjs matrix --out experiments/results
node simulator/cli.mjs matrix --check          # PASS —— 報告可重現
sed -n '1,40p' experiments/results/report.md
```

展示 `report.md`：4 個模擬指標表、每列末的 ASCII 曲線、每個區塊的樣本數、第 5 節 Energy Cost
（Pixel 7 實機量測，非模擬）、Limitations 段落（明確不宣稱固定時間覆蓋全城）。

## 收尾要講的限制

`max_bytes_per_round`（單次接觸的傳輸量）已用 Pixel 7 + Pixel 8a 實機接觸窗量測校準
（3.8–4.4 KB/s），不再是憑感覺的數字；`contact_probability`（社交接觸機率）與
`transfer_failure_prob`（傳輸失敗率）目前沒有對應的實機數據可以直接套，仍是工程估計值。
改 `sim-config.json` 一個檔就能重跑整份報告。詳見 `experiments/limitations.md`。

---

## 5. 民眾回報與政府查證（實機，debug build）

前置：兩到三台手機裝 debug APK，都開 Emergency Mode；筆電有 Node.js。官方金鑰要先進 App 的信任清單：

```
node pipeline/cli.mjs keygen --out-dir .stage2-keys --key-id gov-attest-demo-2026
node -e "const c=require('node:crypto');console.log(c.createPublicKey(require('node:fs').readFileSync('.stage2-keys/public-key.pem')).export({format:'der',type:'spki'}).toString('base64'))"
# 把輸出以 "gov-attest-demo-2026": "<base64>" 加進 android/app/src/main/assets/trust/trusted-keys.json，重新 build 並安裝
```

1. A 在地圖按「回報告警」，選類別、位置，確認送出。地圖出現紫色標記，詳情寫「未經查證，僅供參考」。
2. B、C 靠近 A；幾分鐘內它們的地圖也出現同一筆紫色回報（`signing_key_id` 是 A 的）。
3. 從任何一台匯出回報並交給筆電（上行 demo 版）：

```
adb shell am broadcast -a com.resilientgeo.mesh.debug.EXPORT_CROWD_REPORTS -n com.resilientgeo.mesh/.debug.CrowdDebugReceiver
adb pull /sdcard/Android/data/com.resilientgeo.mesh/files/crowd-export/ .stage2-bundle/crowd-export
node pipeline/cli.mjs attest --report .stage2-bundle/crowd-export/<檔名>.json --event-id <回報 event_id> --verdict CONFIRMED --private-key .stage2-keys/private-key.pem --key-id gov-attest-demo-2026 --out .stage2-bundle/attestation.json
node pipeline/cli.mjs build --input .stage2-bundle/attestation.json --out-dir .stage2-bundle/attest --private-key .stage2-keys/private-key.pem --key-id gov-attest-demo-2026
```

4. 把分片放回任何一台手機（下行 demo 版），再由 mesh 傳給其他手機：

```
adb push .stage2-bundle/attest/chunks/. /sdcard/Android/data/com.resilientgeo.mesh/files/chunk-import/
adb shell am broadcast -a com.resilientgeo.mesh.debug.IMPORT_CHUNKS -n com.resilientgeo.mesh/.debug.CrowdDebugReceiver
```

5. A、B、C 的回報改為青綠色，詳情寫「已查證（官方確認）」。用 `--verdict REFUTED --previous .stage2-bundle/attestation.json` 再跑一次，回報會從地圖消失，通知頁顯示「查證為假」。

## 6. 離線逃生路線（實機）

情境檔：`data/fixtures/neihu/evacuation-scenario.json`（合成事件，建立在真實 OSM 幾何上；由 `pipeline/tools/generate-evacuation-scenario.mjs` 產生）。先連線下載並驗證簽章的避難所 layer，確認離線快取完成，再切至飛航模式測試；目前 APK 不再內建 2026-09-26 的舊避難所快照。

1. 飛航模式，把位置設在 121.566, 25.081（西湖），按「推薦最近避難所」：推薦 **西湖國小**，約 370 m。
2. 送來封路事件（mesh 或 debug 匯入 `android/app/src/main/assets/fixtures/evacuation-scenario/step2-road-closed.json`）：畫面提示「路線資訊已變更」，重新計算後仍是西湖國小，但改走另一條路（約 480 m），結果列出被避開的封路。
3. 送來 `step3-shelter-full.json`（西湖國小額滿）：重新推薦後改為 **西湖國中**（約 670 m）。

同一組步驟在 JVM 裡由 `EvacuationScenarioTest` 使用兩個路線測試點自動重播；該測試不讀取或打包正式避難所 layer。實機建議在離線前確認西湖國小與西湖國中都已出現在下載後的避難所圖層。

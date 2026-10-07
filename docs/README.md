# 文件索引

更新日期：2026-10-05。底圖使用方式見根目錄 [Map_description.md](../Map_description.md)；Server 與資料來源狀態見 [資料說明](../data_description.md) 和 [點位涵蓋報告](data-coverage-2026-10-04.md)。本機實作不代表已部署或通過實機驗收。

## 目前使用的文件

| 用途 | 文件 |
| --- | --- |
| 專案介紹、安裝與執行 | [主 README](../README.md) |
| 完成項目、剩餘功能與實機驗收 | [MVP 進度總表](mvp-remaining-tasks.md) |
| 資料一致性、TTL、推薦與兩機修正 | [可靠性與實機驗證](reliability-device-validation.md) |
| 同步狀態頁與避難災害情境 | [功能與驗證紀錄](sync-status-disaster-filter.md) |
| 事件更新與到期自動重算路線 | [自動重算與實機驗證](automatic-route-refresh.md) |
| Central Server 政府 API 更新、簽章 release 與離線轉傳邊界 | [Central Server 政府資料更新](government-online-sync.md) |
| 目前 OSM 底圖與歷史 NLSC 試用範圍 | [Map description](../Map_description.md) |
| Server、資料串接、門牌包與醫療／避難所涵蓋 | [資料說明](../data_description.md)、[點位涵蓋報告](data-coverage-2026-10-04.md) |
| Web／Android 同步開發規則與資料整合 | [前端整合](frontend-real-data-integration.md#web-與-android-同步開發規則) |
| 系統架構、開發階段與驗收條件 | [系統實作計畫](../system.md)，目前狀態以開頭進度表與 MVP 進度總表為準 |
| 雙北路網與 Pixel 8a 效能 | [雙北離線路線紀錄](taipei-offline-routing.md) |
| Android 建置與 Flutter 操作 | [Android README](../android/README.md)、[Flutter README](../flutter/README.md) |
| 地圖、搜尋與路網重建 | [地圖工具 README](../tools/maps/README.md) |
| 事件、簽章與同步契約 | [資料契約](data-contract-v0.md)、[Peer Sync 協定](peer-sync-v0.md) |
| 前端資料整合與資料來源 | [前端整合](frontend-real-data-integration.md)、[來源盤點](neihu-online-data-sources.md) |
| 模擬器、報告與資料集 | [Simulator README](../simulator/README.md)、[實驗 README](../experiments/README.md)、[資料 README](../data/README.md)、[Fixture README](../fixtures/README.md) |
| 已知限制 | [限制聲明](../experiments/limitations.md) |

## 保留的設計與計畫

- [地圖互動與搜尋規格](superpowers/specs/2026-09-22-taiwan-map-interaction-search-design.md)、[跨平台離線地圖規格](superpowers/specs/2026-09-23-cross-platform-offline-map-runtime-design.md)：保留設計取捨；目前搜尋與標記的效能實作另見雙北離線路線紀錄。
- [回報與政府查證計畫](superpowers/plans/2026-09-24-crowd-report-verification.md)、[回報與路線 UI 計畫](superpowers/plans/2026-09-24-flutter-crowd-alert-evacuation-ui.md)、[逃生路線計畫](superpowers/plans/2026-09-24-evacuation-routing.md)：程式已實作，仍有離線及多機驗收待辦，詳細狀態見進度總表 F、G 段。
- [地圖標記效能計畫](superpowers/plans/2026-09-26-map-marker-performance.md)：保留其他機型、持續升溫與 Chrome 手勢量測待辦，另見進度總表 H 段。
- [ADR-001](adr/ADR-001-transport-layer.md)、[BLE 原始實測筆記](../C_BLEbroadcast.md)、[耗電原始紀錄](../experiments/results/energy-raw/README.md)：決策與實測證據，保留供追溯。

## 2026-09-27 文件清理

以下五份已被目前文件取代，從工作目錄移除。清理前版本均保存在 Git 提交 `ff490cb`；可用 `git show ff490cb:<原路徑>` 讀取。

| 原路徑 | 清理原因與目前入口 |
| --- | --- |
| `README-template.md` | 尚未填寫的模板；專案介紹已在主 README。 |
| `plans/neihu-dataset-area-chunking.md` | 已完成的資料集與地理分片計畫；資料契約、Fixture README 與 Pipeline README 已記錄目前規則。 |
| `plans/experiment-harness.md` | 已完成的模擬器建置計畫，仍寫著尚無 simulator 與 experiments；操作及結果已在 Simulator README 與實驗文件。 |
| `docs/superpowers/plans/2026-09-22-taiwan-map-interaction-search.md` | 已完成的地圖搜尋實作步驟，部分效能方案已被背景搜尋取代；規格保留，操作見 Flutter README，最新驗證見雙北離線路線紀錄。 |
| `docs/superpowers/plans/2026-09-23-cross-platform-offline-map-runtime.md` | 已完成的跨平台 runtime 實作步驟；設計規格保留，現行建置與離線 preview 指令見主 README 與各模組 README。 |

本次只清理文件，沒有移除程式、測試、資料資產或原始量測。

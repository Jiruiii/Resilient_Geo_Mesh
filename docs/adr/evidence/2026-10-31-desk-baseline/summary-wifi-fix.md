# 傳輸修正實機驗證（2026-10-31 08:06–08:47）

- 驗證 2026-10-31 的三個傳輸修正，條件與 [夜間桌面基準](summary.md) 相同：Pixel 8a 發送、Samsung SM-A5360 接收，桌上約 1 公尺。Pixel 這次沒有充電（USB 未供電），電量從 45% 用到 37%。
- 先跑 Nearby 10.5 MB，重現夜間「Nearby 之後 Wi-Fi Direct 卡住」的條件，再跑 Wi-Fi Direct。
- 只計第二輪（08:06 起）。第一輪的 Wi-Fi Direct 修正還不完整，跑到一半就停了，那幾列仍在 CSV 裡，`notes` 同樣是 `desk-1m-wifi-fix`，但時間在 00:06Z 之前。
- Nearby 收件佇列的修正（`NearbyReceiveQueue`）**不在**這次安裝的版本裡。Nearby 39 MB 是靠斷線重連補完的，見下方說明。
- 時間都從接收端按下開始算起。BLE 那一列跨兩次連線，速度欄沒有參考價值。

| 資料量 | 傳輸 | 成功 | 發現 p50／p95（秒） | 完成 p50／p95（秒） | 中位數速度 | 重啟 | 失敗原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 約 1.7 MB | BLE | 2/2 | 0.1／0.1 | 540.3／544.8 | 8.6 KB/s | 0 | — |
| 約 10.5 MB | Nearby | 3/3 | 0.3／0.5 | 28.2／28.5 | 465.6 KB/s | 0 | — |
| 約 10.5 MB | Wi-Fi Direct | 5/5 | 3.1／62.3 | 26.9／210.5 | 519.6 KB/s | 0 | — |
| 全部約 39 MB | Nearby | 1/1 | 0.5／0.5 | 145.9／145.9 | 1.36 MB/s | 0 | — |
| 全部約 39 MB | Wi-Fi Direct | 3/3 | 5.7／21.8 | 111.2／127.1 | 388.1 KB/s | 0 | — |

原始資料：同資料夾的 CSV（14 列接收端試驗；發送端每次連線另有一列）。

**對照夜間基準**：BLE 1.7 MB 0/5 → 2/2；Nearby 10.5 MB 2/3 → 3/3；Wi-Fi Direct 10.5 MB 1/5 → 5/5；Nearby 39 MB 0/3 → 1/1；Wi-Fi Direct 39 MB 5/5 → 3/3。

**log 看到的過程**：
- Wi-Fi Direct 第 1 次：Pixel 兩次被邀入群組時，系統都用「只拿 IPv6 本機位址」的模式（`start Ip client with provisioning mode: 1`），20 秒後退出。之後改由 Pixel 自己邀請（第一次被系統丟掉，2 秒後重試成功），這次是 mode 0，拿到 IPv4，socket 立刻接上，總共 210 秒。之後 4 次都沒有再出現 mode 1，其中 3 次約 27 秒。第 2 次的 86 秒是發現和邀請比較慢，群組本身正常。
- Nearby 39 MB：接收端兩次記到 `Rejected payload: Nearby receive queue full`。這是我們自己的 8 則收件佇列滿了，程式主動斷線，不是升級本身失敗。兩次都由對方重連，這邊結束舊交換（`started a new session; ending the stale exchange`），第三次完成。
- BLE 1.7 MB：第一次連線在 300 秒上限被切斷，對方重連後，這邊結束舊交換，新的一次只補剩下那一片，約 540 秒完成。
- Wi-Fi Direct 39 MB 中位數 111 秒，比夜間的 78 秒慢，慢在傳輸階段。後續比對見 [`summary-nearby-queue.md`](summary-nearby-queue.md)：沒有證據指向修正本身，原因未確認。

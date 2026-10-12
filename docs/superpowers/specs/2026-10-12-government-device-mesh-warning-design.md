# 政府手機離線 Mesh 警告設計

## 已確認需求

- 已登入並完成設備授權的政府 Android 手機，可在離線時建立全台官方警告，使用既有 mesh 傳輸散播；恢復網路後將原始簽章事件補傳至雲端。
- 政府手機設備憑證有效期為 7 天，連線時自動續期。憑證有效期間可建立新的離線官方警告；已在憑證有效期間簽署的警告，在警告本身有效期間內仍可驗證與轉傳。
- Android 使用既有「緊急模式」啟動 mesh。警告可先保存於本機；緊急模式啟用後參與 mesh 同步。
- Flutter Web 保留線上建立與同步，使用相同官方事件及驗證規則，不執行 Android BLE mesh 傳輸。
- 民眾回報維持未查證，只有政府人員完成查證後才顯示 `CONFIRMED` 或 `REFUTED`。
- 「政府來源已驗證」表示授權憑證、簽章及內容完整性通過驗證，不代表系統獨立證明事件事實正確。

## 現況與主要改動

目前政府工作台公告需連線寫入 API，再由內部 `government-publisher` 產生中央簽章事件。Android mesh 可轉傳已同步的官方 feed；手機端尚無政府設備憑證、離線官方警告工廠或政府警告上傳佇列。現有 `device:` 自我識別金鑰只允許簽署 `crowd.*` 事件。

新流程沿用 event-v0、Ed25519、PostgreSQL outbox、中央簽章 feed 及 Android Room／mesh chunk。政府裝置私鑰只在該裝置上使用；中央私鑰仍只在內部發布 worker。發布 worker 對離線警告保留原始設備簽章，並以中央簽章保護公開 feed 的 manifest 與 chunks。

## 設備憑證

新增 `government-device-certificate-v1` 文件。簽章涵蓋除 `signature` 外的所有欄位：

```json
{
  "schema_version": "government-device-certificate-v1",
  "certificate_id": "gov-cert:<uuid>",
  "device_id": "gov-device:<uuid>",
  "subject_id": "<opaque uuid>",
  "signing_key_id": "device:<public-key-fingerprint>",
  "signer_public_key": "<base64 SPKI DER>",
  "agency": "<government agency>",
  "permissions": ["official.announcement.publish"],
  "issued_at": "<RFC 3339 UTC>",
  "expires_at": "<issued_at + 7 days>",
  "issuer_key_id": "<trusted central signing key id>",
  "signature_algorithm": "Ed25519",
  "signature": "<base64 Ed25519 signature>"
}
```

`subject_id` and `device_id` are opaque identifiers; the government account name is not distributed in mesh events. The API binds the device record to the authenticated account. An active government account registers its Android public key. A certificate-signing request enters the PostgreSQL outbox; only the internal publisher signs it. The device retrieves the result from the authenticated API. Renewal creates a new certificate. Disabling an account revokes its devices; a system administrator can revoke an individual device.

## Government warning event and mesh chunk

Android warning creation always uses the authorized device key, whether or not the phone currently has internet; upload is queued separately. An event uses `event-v0`, namespace `official.announcement`, source `GOVERNMENT`, event type `GOVERNMENT_ANNOUNCEMENT`, nationwide `area_id=tw.national`, and the existing announcement fields, optional point, and maximum 90-day lifetime. `attributes.government_device_certificate` carries the signed certificate. `signer_public_key` and `signing_key_id` identify the same Ed25519 key as the certificate. The event signature covers the event payload, including the attached certificate.

The device wraps each warning in a one-event `chunk-v0` dataset named `government-device-announcements` and signs the chunk with its government device key. A receiver accepts it only after validating the certificate issuer signature, certificate key fingerprint, warning permission, certificate validity at `event.issued_at`, event payload hash, event signature, chunk hash, and chunk signature. Device keys remain restricted to crowd events unless a matching government certificate authorizes `official.announcement`.

Room stores the signed event, its chunk and a durable cloud-upload state. Existing mesh inventory advertises and relays the chunk unchanged. The warning appears locally as government-verified after validation. The UI distinguishes local save/mesh eligibility from confirmed peer delivery; the mesh protocol does not provide a delivery receipt to the composer.

## Cloud synchronization and revisions

`POST /api/v1/government/warnings` accepts the original signed event under the current government session. The API checks the active account, device ownership/status, certificate, schema, signature, payload hash, event lifetime and duplicate event id. Exact retries are idempotent; the same event id with different content is rejected. Accepted events enter PostgreSQL and the publisher outbox.

The public `government-announcements` feed includes the original event and device signature; its manifest and chunks remain centrally signed. Existing centrally signed Web announcements continue through the existing path. Online revisions and retractions keep the same event id and increment the version; the publisher signs those newer versions centrally. This preserves one canonical current announcement across mesh and cloud.

## Revocation and offline limits

The publisher distributes centrally signed device-revocation records in an internal `government-device-revocations` feed dataset. These event-v0 records use namespace `official.device-revocation`, a long-lived expiry (`2100-01-01T00:00:00Z`), and contain only certificate/device identifiers and `revoked_at`. Clients cache those records and relay them through mesh. A known revocation invalidates warnings signed by that certificate at or after its revocation time; earlier warnings remain valid until their own expiry. Revocation records are hidden from user notification lists.

An offline phone cannot receive a revocation that has not reached it. Its peers can verify the certificate signature and 7-day validity, but may not know a recent revocation until they sync. On reconnect, the API rejects upload from a revoked device. The UI exposes certificate expiry and last revocation sync time so operators can see trust freshness.

## Web and Android responsibilities

- Android handles government key creation, authenticated enrollment/renewal, offline warning creation, Room persistence, mesh sharing while Emergency Mode is enabled, and retrying cloud upload.
- Flutter Web handles online government warning creation and validates/displays device-signed events after cloud sync. It has no BLE mesh transport.
- Both Flutter targets use the same API contract, event fields, official verification result, nationwide scope and notification wording.

## Acceptance scenarios

- Active government login enrolls one Android device; certificate issuance is signed by the publisher and the private signing key never appears in the API container.
- Valid certificate creates an offline warning; the signed chunk survives app restart and is eligible for mesh relay.
- A second offline Android device verifies and displays the warning; it rejects altered payloads, mismatched keys, missing certificates, wrong permissions, expired-at-issuance certificates and known-revoked certificates.
- A certificate that expires after an alert was signed does not invalidate that still-current alert; an expired certificate cannot sign a new alert.
- Reconnecting uploads the exact event id and payload idempotently; feed publication makes Web and Android converge on the same version and verified status.
- Device/user revocation is audited, blocks renewal and online upload, and reaches clients through the signed revocation dataset.
- Citizen reports remain `UNVERIFIED` until an official attestation; `REFUTED` never displays as confirmed.
- Web keeps online create/revise/retract and displays the same verified official feed; mesh radio remains Android-only.

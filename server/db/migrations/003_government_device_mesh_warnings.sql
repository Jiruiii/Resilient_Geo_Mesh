CREATE TABLE IF NOT EXISTS government_devices (
  device_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES government_users(id),
  subject_id text NOT NULL,
  signing_key_id text NOT NULL,
  signer_public_key text NOT NULL,
  agency text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_CERTIFICATE', 'ACTIVE', 'REVOKED')) DEFAULT 'PENDING_CERTIFICATE',
  certificate_version integer NOT NULL CHECK (certificate_version > 0) DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (user_id, signing_key_id)
);
CREATE INDEX IF NOT EXISTS government_devices_user_idx ON government_devices(user_id, status);

CREATE TABLE IF NOT EXISTS government_device_certificates (
  certificate_id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES government_devices(device_id),
  certificate_version integer NOT NULL CHECK (certificate_version > 0),
  certificate_json jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (device_id, certificate_version)
);
CREATE INDEX IF NOT EXISTS government_device_certificates_device_idx
  ON government_device_certificates(device_id, certificate_version DESC);

CREATE TABLE IF NOT EXISTS government_warnings (
  event_id text PRIMARY KEY,
  payload_hash text NOT NULL,
  event_json jsonb NOT NULL,
  device_id text NOT NULL REFERENCES government_devices(device_id),
  certificate_id text NOT NULL REFERENCES government_device_certificates(certificate_id),
  uploaded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  publication_status text NOT NULL CHECK (publication_status IN ('QUEUED', 'PUBLISHED')) DEFAULT 'QUEUED'
);
CREATE INDEX IF NOT EXISTS government_warnings_ready_idx ON government_warnings(publication_status, expires_at, uploaded_at);

ALTER TABLE government_outbox DROP CONSTRAINT IF EXISTS government_outbox_aggregate_type_check;
ALTER TABLE government_outbox ADD CONSTRAINT government_outbox_aggregate_type_check
  CHECK (aggregate_type IN ('ANNOUNCEMENT', 'ATTESTATION', 'DEVICE_CERTIFICATE', 'DEVICE_REVOCATION', 'DEVICE_WARNING'));

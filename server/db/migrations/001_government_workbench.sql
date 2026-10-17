CREATE TABLE IF NOT EXISTS government_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  agency text NOT NULL,
  role text NOT NULL CHECK (role IN ('GOVERNMENT', 'SYSTEM_ADMIN')),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')) DEFAULT 'ACTIVE',
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS government_sessions (
  id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  user_id uuid NOT NULL REFERENCES government_users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  user_agent text
);
CREATE INDEX IF NOT EXISTS government_sessions_user_idx ON government_sessions(user_id);

CREATE TABLE IF NOT EXISTS crowd_reports (
  event_id text PRIMARY KEY,
  payload_hash text NOT NULL,
  event_json jsonb NOT NULL,
  uploaded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('PENDING', 'CONFIRMED', 'REFUTED')) DEFAULT 'PENDING',
  decision_version integer NOT NULL DEFAULT 0,
  verdict text CHECK (verdict IN ('CONFIRMED', 'REFUTED')),
  note text,
  decision_issued_at timestamptz,
  published_decision_version integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS crowd_reports_pending_idx ON crowd_reports(verification_status, expires_at);

CREATE TABLE IF NOT EXISTS government_announcements (
  event_id text PRIMARY KEY,
  event_version integer NOT NULL CHECK (event_version > 0),
  announcement_json jsonb NOT NULL,
  retracted boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES government_users(id),
  updated_by uuid NOT NULL REFERENCES government_users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS government_outbox (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('ANNOUNCEMENT', 'ATTESTATION')),
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'REJECTED')) DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);
CREATE INDEX IF NOT EXISTS government_outbox_ready_idx ON government_outbox(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS government_audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES government_users(id),
  action text NOT NULL,
  subject_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS government_audit_created_idx ON government_audit_log(created_at DESC);

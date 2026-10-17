DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'government_users' AND column_name = 'email'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'government_users' AND column_name = 'account'
  ) THEN
    ALTER TABLE government_users RENAME COLUMN email TO account;
  END IF;
END
$$;

DROP TABLE IF EXISTS government_invitations;
CREATE UNIQUE INDEX IF NOT EXISTS government_users_account_lower_idx ON government_users (lower(account));

-- Create sync_metadata table for tracking sync state
-- Used by bidirectional sync services to track last sync times and other metadata

CREATE TABLE IF NOT EXISTS sync_metadata (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Add index for quick lookups
CREATE INDEX IF NOT EXISTS idx_sync_metadata_updated_at ON sync_metadata(updated_at);

-- Insert initial records for known sync jobs
INSERT INTO sync_metadata (key, value) VALUES
  ('dutchie_to_postgres_last_sync', '1970-01-01T00:00:00.000Z'),
  ('odoo_to_postgres_last_sync', '1970-01-01T00:00:00.000Z'),
  ('postgres_to_odoo_last_sync', '1970-01-01T00:00:00.000Z')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE sync_metadata IS 'Stores sync state and metadata for bidirectional sync services';

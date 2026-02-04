-- Add source column to inventory table
-- Tracks where the inventory record originated from
-- Values: 'dutchie' (POS sync), 'odoo' (ERP master), 'manual' (direct entry)

-- Source system that created/owns this record
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'dutchie';

-- Timestamp of last sync from source system
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS source_synced_at TIMESTAMPTZ;

-- External ID in source system (for Odoo: product.product id)
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS source_external_id VARCHAR(255);

-- Create index for filtering by source
CREATE INDEX IF NOT EXISTS idx_inventory_source ON inventory(source);

-- Update existing records to mark as dutchie-sourced
UPDATE inventory SET source = 'dutchie' WHERE source IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN inventory.source IS 'Origin system: dutchie, odoo, or manual';
COMMENT ON COLUMN inventory.source_synced_at IS 'Last sync timestamp from source system';
COMMENT ON COLUMN inventory.source_external_id IS 'ID in source system (e.g., Odoo product.product id)';

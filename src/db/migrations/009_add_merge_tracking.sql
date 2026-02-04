-- Add merge tracking columns to inventory table
-- Enables unified product records where Dutchie fields are authoritative
-- and Odoo supplements with additional data (fills nulls)

-- Add barcode column (used by Odoo sync for product matching)
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS barcode VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode);

-- Store Dutchie IDs for bidirectional tracking
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS dutchie_product_id VARCHAR(255);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS dutchie_inventory_id VARCHAR(255);

-- Track merge state: 'dutchie_only', 'odoo_only', 'merged'
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS merge_status VARCHAR(50);

-- Timestamp when records were merged
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

-- Create indexes for merge queries
CREATE INDEX IF NOT EXISTS idx_inventory_merge_status ON inventory(merge_status);
CREATE INDEX IF NOT EXISTS idx_inventory_dutchie_product_id ON inventory(dutchie_product_id);

-- Backfill existing Dutchie records
UPDATE inventory
SET dutchie_product_id = product_id,
    dutchie_inventory_id = inventory_id,
    merge_status = 'dutchie_only'
WHERE source = 'dutchie' AND dutchie_product_id IS NULL;

-- Mark existing Odoo-only records
UPDATE inventory
SET merge_status = 'odoo_only'
WHERE source = 'odoo' AND merge_status IS NULL;

-- Add comments for documentation
COMMENT ON COLUMN inventory.dutchie_product_id IS 'Product ID from Dutchie POS (preserved during merge)';
COMMENT ON COLUMN inventory.dutchie_inventory_id IS 'Inventory ID from Dutchie POS (preserved during merge)';
COMMENT ON COLUMN inventory.merge_status IS 'Merge state: dutchie_only, odoo_only, or merged';
COMMENT ON COLUMN inventory.merged_at IS 'Timestamp when Dutchie and Odoo records were merged';

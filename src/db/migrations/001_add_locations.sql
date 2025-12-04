-- Migration: Add location support
-- Run this to add location_id to existing inventory table

-- Create locations table
CREATE TABLE IF NOT EXISTS locations (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add location_id column to inventory
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS location_id VARCHAR(255);

-- Drop old unique constraint if exists
ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_product_id_inventory_id_key;

-- Create index on location_id
CREATE INDEX IF NOT EXISTS idx_inventory_location_id ON inventory(location_id);

-- Add new unique constraint (location_id + inventory_id)
-- Note: Run this after updating existing rows with a location_id
-- ALTER TABLE inventory ADD CONSTRAINT inventory_location_inventory_unique UNIQUE (location_id, inventory_id);

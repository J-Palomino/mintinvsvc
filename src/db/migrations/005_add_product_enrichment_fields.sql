-- Add product enrichment fields to discounts table
-- These fields are populated from the inventory table during sync
-- For discounts that apply to specific products, we store the first matching product's info

-- Product display name
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS product_name VARCHAR(500);

-- Brand/manufacturer name
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255);

-- Product category
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS category VARCHAR(255);

-- Product image URL (from Dutchie CDN)
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Product unit price
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10, 4);

-- Array of all applicable products with details (for discounts with multiple products)
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS product_details JSONB;

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_discounts_product_name ON discounts(product_name);
CREATE INDEX IF NOT EXISTS idx_discounts_brand_name ON discounts(brand_name);
CREATE INDEX IF NOT EXISTS idx_discounts_category ON discounts(category);

-- Locations Table
CREATE TABLE IF NOT EXISTS locations (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tickertape TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Dutchie Inventory Table
CREATE TABLE IF NOT EXISTS inventory (
    -- Primary identifiers
    id VARCHAR(255) PRIMARY KEY,
    location_id VARCHAR(255) NOT NULL,
    product_id VARCHAR(255),
    inventory_id VARCHAR(255),
    sku VARCHAR(255),

    -- Product names and descriptions
    internal_name VARCHAR(500),
    product_name VARCHAR(500),
    name VARCHAR(500),
    description TEXT,
    description_html TEXT,

    -- Categories
    master_category VARCHAR(255),
    category_id VARCHAR(255),
    category VARCHAR(255),

    -- Images
    image_url TEXT,
    image_urls JSONB,
    images JSONB,

    -- Strain information
    strain_id VARCHAR(255),
    strain VARCHAR(255),
    strain_type VARCHAR(100),

    -- Weight and size
    size VARCHAR(100),
    net_weight DECIMAL(10, 4),
    net_weight_unit_id VARCHAR(50),
    net_weight_unit VARCHAR(50),
    unit_weight DECIMAL(10, 4),
    unit_weight_unit VARCHAR(50),

    -- Brand and vendor
    brand_id VARCHAR(255),
    brand_name VARCHAR(255),
    vendor_id VARCHAR(255),
    vendor_name VARCHAR(255),
    vendor JSONB,

    -- Producer
    producer_id VARCHAR(255),
    producer_name VARCHAR(255),
    producer JSONB,

    -- Product flags
    is_cannabis BOOLEAN,
    is_active BOOLEAN,
    is_coupon BOOLEAN,
    is_medical_only BOOLEAN,
    medical_only BOOLEAN,
    is_test_product BOOLEAN,
    is_finished BOOLEAN,
    is_taxable BOOLEAN,
    online_product BOOLEAN,
    online_available BOOLEAN,

    -- POS and tags
    pos_products JSONB,
    tags JSONB,
    effects JSONB,

    -- Pricing
    pricing_tier VARCHAR(255),
    pricing_tier_name VARCHAR(255),
    pricing_tier_description TEXT,
    price DECIMAL(10, 2),
    med_price DECIMAL(10, 2),
    rec_price DECIMAL(10, 2),
    unit_cost DECIMAL(10, 4),
    unit_price DECIMAL(10, 4),
    med_unit_price DECIMAL(10, 4),
    rec_unit_price DECIMAL(10, 4),
    unit_type VARCHAR(100),

    -- Online display
    online_title VARCHAR(500),
    online_description TEXT,

    -- Inventory thresholds
    low_inventory_threshold INTEGER,
    max_purchaseable_per_transaction INTEGER,

    -- Additional product info
    alternate_name VARCHAR(500),
    flavor VARCHAR(255),
    lineage_name VARCHAR(255),
    distillation_name VARCHAR(255),
    dosage VARCHAR(255),
    instructions TEXT,
    allergens TEXT,
    standard_allergens JSONB,
    default_unit VARCHAR(100),

    -- Dates
    created_date TIMESTAMP,
    last_modified_date_utc TIMESTAMP,

    -- Weight and tax
    gross_weight DECIMAL(10, 4),
    tax_categories JSONB,

    -- Regulatory and compliance
    upc VARCHAR(100),
    regulatory_category VARCHAR(255),
    ndc VARCHAR(100),
    days_supply INTEGER,
    illinois_tax_category VARCHAR(255),

    -- External integrations
    external_category VARCHAR(255),
    external_id VARCHAR(255),
    sync_externally BOOLEAN,

    -- Regulatory and medical
    regulatory_name VARCHAR(500),
    administration_method VARCHAR(255),
    unit_cbd_content_dose DECIMAL(10, 4),
    unit_thc_content_dose DECIMAL(10, 4),
    oil_volume DECIMAL(10, 4),
    ingredient_list TEXT,
    expiration_days INTEGER,

    -- Display
    abbreviation VARCHAR(50),
    allow_automatic_discounts BOOLEAN,
    serving_size VARCHAR(100),
    serving_size_per_unit VARCHAR(100),
    is_nutrient BOOLEAN,
    approval_date_utc TIMESTAMP,

    -- E-commerce
    ecom_category VARCHAR(255),
    ecom_subcategory VARCHAR(255),
    custom_metadata JSONB,

    -- Quantity and inventory
    allocated_quantity DECIMAL(10, 4),
    quantity_available DECIMAL(10, 4),
    quantity_units VARCHAR(100),
    flower_equivalent DECIMAL(10, 4),
    rec_flower_equivalent DECIMAL(10, 4),
    flower_equivalent_units VARCHAR(100),

    -- Batch information
    batch_id VARCHAR(255),
    batch_name VARCHAR(255),
    product_batch_id VARCHAR(255),

    -- Package information
    package_id VARCHAR(255),
    package_status VARCHAR(100),
    external_package_id VARCHAR(255),
    package_ndc VARCHAR(100),

    -- Lab results
    lab_results JSONB,
    lab_test_status VARCHAR(100),
    tested_date TIMESTAMP,
    sample_date TIMESTAMP,
    packaged_date TIMESTAMP,
    manufacturing_date TIMESTAMP,
    expiration_date TIMESTAMP,

    -- Room and lineage
    room_quantities JSONB,
    lineage JSONB,

    -- Potency
    potency_indicator VARCHAR(100),
    effective_potency_mg DECIMAL(10, 4),
    lab_result_url TEXT,
    potency_cbd_formatted VARCHAR(100),
    potency_thc_formatted VARCHAR(100),

    -- E-commerce display
    slug VARCHAR(500),
    staff_pick BOOLEAN,
    broadcasted_responses JSONB,

    -- Metadata
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    UNIQUE (location_id, inventory_id)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_inventory_location_id ON inventory(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_product_id ON inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_category ON inventory(category);
CREATE INDEX IF NOT EXISTS idx_inventory_brand_id ON inventory(brand_id);
CREATE INDEX IF NOT EXISTS idx_inventory_is_active ON inventory(is_active);
CREATE INDEX IF NOT EXISTS idx_inventory_synced_at ON inventory(synced_at);

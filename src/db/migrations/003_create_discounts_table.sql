-- Create discounts table (drop first to ensure clean state)
DROP TABLE IF EXISTS discounts;
CREATE TABLE discounts (
  id VARCHAR(255) PRIMARY KEY, -- locationId_discountId
  location_id VARCHAR(255) NOT NULL,
  discount_id INTEGER NOT NULL,
  discount_name VARCHAR(500),
  discount_code VARCHAR(255),
  discount_type VARCHAR(100),
  discount_method VARCHAR(100),
  discount_amount DECIMAL(18, 4),
  application_method VARCHAR(100),
  external_id VARCHAR(255),

  -- Status flags
  is_active BOOLEAN DEFAULT false,
  is_available_online BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  require_manager_approval BOOLEAN DEFAULT false,

  -- Validity dates
  valid_from TIMESTAMP WITH TIME ZONE,
  valid_until TIMESTAMP WITH TIME ZONE,

  -- Thresholds and limits
  threshold_type VARCHAR(100),
  minimum_items_required DECIMAL(10, 2),
  maximum_items_allowed DECIMAL(10, 2),
  maximum_usage_count DECIMAL(10, 2),

  -- Options
  include_non_cannabis BOOLEAN DEFAULT false,
  first_time_customer_only BOOLEAN DEFAULT false,
  stack_on_other_discounts BOOLEAN DEFAULT false,

  -- Location applicability (JSONB array)
  applies_to_locations JSONB,

  -- Weekly recurrence info (JSONB object)
  weekly_recurrence_info JSONB,

  -- Filter criteria (JSONB objects with ids[] and isExclusion)
  products JSONB,
  product_categories JSONB,
  brands JSONB,
  vendors JSONB,
  strains JSONB,
  tiers JSONB,
  tags JSONB,
  inventory_tags JSONB,
  customer_types JSONB,

  -- Discount groups (JSONB array)
  discount_groups JSONB,

  -- Timestamps
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(location_id, discount_id)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_discounts_location_id ON discounts(location_id);
CREATE INDEX IF NOT EXISTS idx_discounts_is_active ON discounts(is_active);
CREATE INDEX IF NOT EXISTS idx_discounts_valid_dates ON discounts(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_discounts_discount_code ON discounts(discount_code);

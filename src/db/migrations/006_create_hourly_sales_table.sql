-- Migration: Create hourly_sales table for tracking hourly sales aggregates
-- This table stores hourly sales data fetched every hour from Dutchie POS API

CREATE TABLE IF NOT EXISTS hourly_sales (
  id SERIAL PRIMARY KEY,
  location_id VARCHAR(255) NOT NULL,
  branch_code VARCHAR(50) NOT NULL,
  store_name VARCHAR(255) NOT NULL,
  hour_start TIMESTAMP WITH TIME ZONE NOT NULL,
  hour_end TIMESTAMP WITH TIME ZONE NOT NULL,
  gross_sales NUMERIC(12, 2) DEFAULT 0,
  discounts NUMERIC(12, 2) DEFAULT 0,
  returns NUMERIC(12, 2) DEFAULT 0,
  net_sales NUMERIC(12, 2) DEFAULT 0,
  tax NUMERIC(12, 2) DEFAULT 0,
  transaction_count INTEGER DEFAULT 0,
  cash_paid NUMERIC(12, 2) DEFAULT 0,
  debit_paid NUMERIC(12, 2) DEFAULT 0,
  loyalty_spent NUMERIC(12, 2) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Prevent duplicate entries for same store/hour
  CONSTRAINT hourly_sales_unique UNIQUE (location_id, hour_start)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_hourly_sales_location ON hourly_sales(location_id);
CREATE INDEX IF NOT EXISTS idx_hourly_sales_hour_start ON hourly_sales(hour_start);
CREATE INDEX IF NOT EXISTS idx_hourly_sales_branch_code ON hourly_sales(branch_code);
CREATE INDEX IF NOT EXISTS idx_hourly_sales_location_hour ON hourly_sales(location_id, hour_start DESC);

COMMENT ON TABLE hourly_sales IS 'Hourly sales aggregates fetched from Dutchie POS API every hour';
COMMENT ON COLUMN hourly_sales.hour_start IS 'Start of the hour in UTC';
COMMENT ON COLUMN hourly_sales.hour_end IS 'End of the hour in UTC';
COMMENT ON COLUMN hourly_sales.gross_sales IS 'Total sales before discounts (subtotal)';
COMMENT ON COLUMN hourly_sales.net_sales IS 'gross_sales - discounts - returns';

-- Fix numeric field overflow by increasing precision
-- DECIMAL(10,4) can only hold values up to 999999.9999
-- Changing to DECIMAL(18,4) allows values up to 99999999999999.9999

ALTER TABLE inventory
  ALTER COLUMN net_weight TYPE DECIMAL(18, 4),
  ALTER COLUMN unit_weight TYPE DECIMAL(18, 4),
  ALTER COLUMN price TYPE DECIMAL(18, 2),
  ALTER COLUMN med_price TYPE DECIMAL(18, 2),
  ALTER COLUMN rec_price TYPE DECIMAL(18, 2),
  ALTER COLUMN unit_cost TYPE DECIMAL(18, 4),
  ALTER COLUMN unit_price TYPE DECIMAL(18, 4),
  ALTER COLUMN med_unit_price TYPE DECIMAL(18, 4),
  ALTER COLUMN rec_unit_price TYPE DECIMAL(18, 4),
  ALTER COLUMN gross_weight TYPE DECIMAL(18, 4),
  ALTER COLUMN unit_cbd_content_dose TYPE DECIMAL(18, 4),
  ALTER COLUMN unit_thc_content_dose TYPE DECIMAL(18, 4),
  ALTER COLUMN oil_volume TYPE DECIMAL(18, 4),
  ALTER COLUMN allocated_quantity TYPE DECIMAL(18, 4),
  ALTER COLUMN quantity_available TYPE DECIMAL(18, 4),
  ALTER COLUMN flower_equivalent TYPE DECIMAL(18, 4),
  ALTER COLUMN rec_flower_equivalent TYPE DECIMAL(18, 4),
  ALTER COLUMN effective_potency_mg TYPE DECIMAL(18, 4);

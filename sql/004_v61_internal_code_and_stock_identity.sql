-- V61: preserve PDV internal code and prevent ambiguous SKU-only stock moves.
ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_code text;
CREATE INDEX IF NOT EXISTS idx_products_internal_code ON products(internal_code) WHERE internal_code IS NOT NULL;
-- SKU is intentionally NOT unique. Stock operations must use variant_id or barcode;
-- the API rejects SKU-only operations when more than one variant shares that SKU.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS products(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text, barcode text, name text NOT NULL, brand text, category text, subcategory text, description text,
 price numeric(12,2) NOT NULL DEFAULT 0, promo_price numeric(12,2), online_status text NOT NULL DEFAULT 'physical_only' CHECK (online_status IN ('published','physical_only','hidden')),
 featured boolean NOT NULL DEFAULT false, bestseller boolean NOT NULL DEFAULT false, launch boolean NOT NULL DEFAULT false, promotion boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE products ADD COLUMN IF NOT EXISTS photo text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_code text;
CREATE TABLE IF NOT EXISTS product_variants(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, name text NOT NULL, attributes jsonb NOT NULL DEFAULT '{}', sku text, barcode text UNIQUE, price_delta numeric(12,2) NOT NULL DEFAULT 0, stock integer NOT NULL DEFAULT 0 CHECK(stock>=0), reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0), UNIQUE(product_id,name));
CREATE TABLE IF NOT EXISTS customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, phone text, email text UNIQUE, password_hash text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid REFERENCES customers(id), number bigserial UNIQUE, status text NOT NULL DEFAULT 'received', payment_status text NOT NULL DEFAULT 'pending', fulfillment_type text NOT NULL CHECK(fulfillment_type IN ('pickup','francisco_morato_delivery')), delivery_date date, delivery_time text, subtotal numeric(12,2) NOT NULL DEFAULT 0, discount numeric(12,2) NOT NULL DEFAULT 0, total numeric(12,2) NOT NULL DEFAULT 0, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id), variant_id uuid REFERENCES product_variants(id), product_name text NOT NULL, variant_name text, qty integer NOT NULL CHECK(qty>0), unit_price numeric(12,2) NOT NULL);
CREATE TABLE IF NOT EXISTS stock_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, variant_id uuid NOT NULL REFERENCES product_variants(id), qty integer NOT NULL CHECK(qty>0), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','confirmed','released','expired')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS stock_moves(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), variant_id uuid NOT NULL REFERENCES product_variants(id), qty integer NOT NULL, reason text NOT NULL, source text, source_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sync_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity text NOT NULL, entity_id text, direction text NOT NULL, status text NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text, action text NOT NULL, details jsonb, created_at timestamptz NOT NULL DEFAULT now());
-- V61 identity fix: SKU is not a unique identity; barcode is the product identity when present.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_sku_key;

CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status,created_at DESC);

-- V57 payment provider ledger
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- V59 customer area
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE TABLE IF NOT EXISTS customer_addresses(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,label TEXT,address TEXT NOT NULL,city TEXT,state TEXT,zip TEXT,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS favorites(customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,product_id UUID REFERENCES products(id) ON DELETE CASCADE,created_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(customer_id,product_id));
CREATE TABLE IF NOT EXISTS restock_alerts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,product_id UUID REFERENCES products(id) ON DELETE CASCADE,email TEXT,phone TEXT,status TEXT DEFAULT 'active',created_at TIMESTAMPTZ DEFAULT now(),notified_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS product_reviews(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,product_id UUID REFERENCES products(id) ON DELETE CASCADE,order_id UUID REFERENCES orders(id) ON DELETE SET NULL,rating INT CHECK(rating BETWEEN 1 AND 5),comment TEXT,status TEXT DEFAULT 'pending',verified_purchase BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS loyalty_ledger(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,points INT NOT NULL,reason TEXT,order_id UUID REFERENCES orders(id) ON DELETE SET NULL,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS coupons(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),code TEXT UNIQUE NOT NULL,discount_type TEXT NOT NULL,discount_value NUMERIC(12,2) NOT NULL,starts_at TIMESTAMPTZ,ends_at TIMESTAMPTZ,min_order NUMERIC(12,2) DEFAULT 0,max_uses INT,uses_count INT DEFAULT 0,active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS abandoned_carts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,email TEXT,cart JSONB NOT NULL DEFAULT '[]',status TEXT DEFAULT 'open',created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());

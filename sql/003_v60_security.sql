-- V60: índices e trilha de segurança para produção
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_date_time ON orders(delivery_date, delivery_time);
CREATE INDEX IF NOT EXISTS idx_reservations_expires_active ON stock_reservations(expires_at) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_payments_order_status ON payments(order_id, status);

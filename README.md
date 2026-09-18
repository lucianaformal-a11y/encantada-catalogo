# Encantada — Catálogo + API

Projeto preparado para publicação no Render com banco PostgreSQL/Supabase.

## Deploy
- Render: `npm ci` / `npm start`
- Variáveis obrigatórias: DATABASE_URL, JWT_SECRET, CUSTOMER_JWT_SECRET, PUBLIC_URL, CORS_ORIGIN.
- O catálogo é servido por `public/index.html` no mesmo endereço da API.

## Segurança
Segredos reais não fazem parte deste repositório. Use as Environment Variables do Render.

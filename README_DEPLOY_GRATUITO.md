# Encantada — publicação gratuita do catálogo

Esta versão está preparada para usar **um único serviço Render Free** para API + catálogo, e **Supabase Free** para o PostgreSQL.

## Estrutura

- Render: API Node + catálogo estático no mesmo endereço.
- Supabase: PostgreSQL.
- O catálogo usa `window.location.origin`, então não precisa configurar manualmente a API no navegador.
- O PDV local continua podendo usar `localStorage.setItem('encantada_api_url', 'https://SEU-ENDERECO.onrender.com')` ou a configuração equivalente existente.

## 1. Criar o banco gratuito

1. Criar uma conta no Supabase.
2. Criar um projeto Free.
3. Abrir o SQL Editor.
4. Executar, nesta ordem:
   - `SISTEMA/backend/sql/001_schema.sql`
   - `SISTEMA/backend/sql/003_v60_security.sql`
   - `SISTEMA/backend/sql/004_v61_internal_code_and_stock_identity.sql`
5. Copiar a connection string PostgreSQL do projeto e usar como `DATABASE_URL` no Render.

## 2. Publicar no Render

O repositório precisa conter a pasta `SISTEMA/backend`.

No Render:

- New → Web Service
- conectar o repositório
- Root Directory: `SISTEMA/backend`
- Build Command: `npm ci`
- Start Command: `npm start`
- Plan: `Free`

Variáveis obrigatórias:

- `NODE_ENV=production`
- `DATABASE_URL=<connection string do Supabase>`
- `JWT_SECRET=<chave aleatória com 32+ caracteres>`
- `CUSTOMER_JWT_SECRET=<outra chave aleatória com 32+ caracteres>`
- `PAYMENT_PROVIDER=mock`

Depois do primeiro deploy, copie o endereço `https://...onrender.com` e coloque esse endereço em:

- `PUBLIC_URL`
- `CORS_ORIGIN`

Faça um novo deploy.

## 3. Testar

Abra `https://SEU-ENDERECO.onrender.com/`.

Esse endereço já é o catálogo.

Teste:

- produtos;
- categorias;
- fotos;
- preços;
- disponibilidade;
- lista;
- solicitação de reserva;
- sincronização do PDV.

## 4. Ligar o PDV ao endereço online

No navegador do PDV, o endereço da API deve ser o mesmo endereço do Render.

Se necessário, no console do navegador:

```js
localStorage.setItem('encantada_api_url','https://SEU-ENDERECO.onrender.com');
location.reload();
```

## Observações importantes

- O Render Free pode desligar o serviço após período de inatividade e o primeiro acesso depois disso pode demorar cerca de um minuto.
- Não usar o PostgreSQL Free do Render para este projeto: o banco gratuito do Render expira após 30 dias. O banco deve ficar no Supabase Free.
- O Supabase Free tem limite de 500 MB de banco e pode pausar projetos sem atividade prolongada.
- Antes de produção, configure um provedor de pagamento real somente se a loja realmente for usar pagamentos online.

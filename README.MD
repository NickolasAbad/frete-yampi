# App Proxy – Frete Yampi

## Rodar local
1. `cp .env.example .env` e preencha credenciais.
2. `npm i`
3. `npm run dev` (ou `npm start`)
4. Teste health: `GET /health`

## Endpoint do App Proxy
- Caminho: `/${SHOPIFY_APP_PROXY_PREFIX}/${SHOPIFY_APP_PROXY_SUBPATH}` (padrão: `/apps/shipping-quotes`)
- Método: **GET** ou **POST**
- Parâmetros:
  - `cep`: CEP apenas dígitos (8)
  - `skus`: lista separada por vírgula com SKUs **textuais** do Shopify (ex.: `SKU1,SKU2`) **ou** `skus_ids` com IDs numéricos da Yampi
  - `quantities`: lista de quantidades (mesma ordem)
  - `total` (opcional): total do carrinho (mantenha coerente com a sua conta Yampi – reais ou centavos)

### Exemplo
- GET /apps/shipping-quotes?cep=01001000&skus=ABC-123,DEF-456&quantities=1,2&total=19900


## Admin
- `POST /admin/refresh-skus` com header `X-Admin-Token: ${ADMIN_TOKEN}` → rehidrata o mapa de SKUs
- `GET  /admin/sku/:sku` (mesma proteção) → consulta um SKU → ID

## Deploy
- Suba este servidor em HTTPS público (Render, Railway, Fly.io, etc.)
- No **Shopify Partners → App → App setup → App proxy**:
  - Prefix: `apps`
  - Subpath: `shipping-quotes`
  - Proxy URL: `https://SEU-DOMINIO/apps/shipping-quotes`

## Dicas
- Se o catálogo for grande, deixe `SKU_SEED_FILE` apontar para um JSON exportado da Yampi para acelerar a primeira carga.
- Ajuste `CACHE_TTL_MS` (padrão 5min) para reduzir chamadas repetidas de frete.
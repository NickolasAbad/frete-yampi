import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { verifyShopifyProxy } from './verifyProxy.js';
import { calcularFreteYampi } from './yampi.js';
import { YampiSkuMap } from './yampiCatalog.js';

const app = express();
app.use(express.json());
app.use(cors());

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES = '',
  APP_URL,
  SHOPIFY_APP_PROXY_PREFIX = 'apps',
  SHOPIFY_APP_PROXY_SUBPATH = 'shipping-quotes',
  DISABLE_PROXY_SIGNATURE_CHECK = 'false',
  YAMPI_ALIAS,
  CACHE_TTL_MS = '300000',
  ADMIN_TOKEN
} = process.env;

// ===== util =====
function assertEnv(name) { if (!process.env[name]) throw new Error(`Env faltando: ${name}`); }
assertEnv('SHOPIFY_API_SECRET');
assertEnv('APP_URL');

function isShopDomain(v) { return /\.(myshopify\.com)$/i.test(v); }

function buildAuthURL(shop, state) {
  const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
  const usp = new URLSearchParams({
    client_id: SHOPIFY_API_KEY,
    scope: SCOPES || '',
    redirect_uri: redirectUri,
    state
  });
  return `https://${shop}/admin/oauth/authorize?${usp.toString()}`;
}

function verifyOAuthHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  const msg = Object.keys(rest)
    .sort((a, b) => (a < b ? -1 : 1))
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  return digest === hmac;
}

// ===== memory stores =====
const states = new Map(); // shop -> state

// ===== SKU map (não bloquear boot) =====
const skuMap = new YampiSkuMap(YAMPI_ALIAS, { refreshMs: 15 * 60 * 1000 });
skuMap.bootstrap().catch((e) => console.warn('[SKU MAP] bootstrap falhou:', e.message));

// ===== cache simples =====
const quoteCache = new Map();
const TTL = Number(CACHE_TTL_MS) || 300000;
const cacheKey = (x) => JSON.stringify(x);

// ===== páginas básicas =====
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><body>
  <h1>Frete Yampi App</h1>
  <p>Use <code>/install?shop=loja.myshopify.com</code> para instalar.</p>
  </body></html>`);
});

app.get('/installed', (req, res) => {
  res.type('html').send(`<!doctype html><html><body>
  <h2>App instalado ✅</h2>
  <p>O proxy está pronto em <code>/${SHOPIFY_APP_PROXY_PREFIX}/${SHOPIFY_APP_PROXY_SUBPATH}</code>.</p>
  </body></html>`);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ===== fluxo de instalação =====
app.get('/install', (req, res) => {
  const shop = String(req.query.shop || '').toLowerCase();
  if (!isShopDomain(shop)) return res.status(400).send('Parâmetro shop inválido');
  const state = crypto.randomBytes(16).toString('hex');
  states.set(shop, state);
  const url = buildAuthURL(shop, state);
  return res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, hmac, code, state } = req.query;
    if (!shop || !code || !hmac) return res.status(400).send('params inválidos');
    if (!verifyOAuthHmac(req.query, SHOPIFY_API_SECRET)) return res.status(401).send('hmac inválido');
    const expected = states.get(shop);
    if (!expected || expected !== state) return res.status(401).send('state inválido');

    // troca code por access token (mesmo que não usemos)
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code })
    });
    if (!tokenRes.ok) return res.status(500).send('falha ao obter token');
    const tokenJson = await tokenRes.json();
    // você pode persistir tokenJson.access_token por shop, se precisar.

    states.delete(shop);
    // redireciona para a página do app (App URL)
    const appUrl = `${APP_URL.replace(/\/$/, '')}/installed`;
    return res.redirect(appUrl + `?shop=${encodeURIComponent(shop)}`);
  } catch (e) {
    console.error('[oauth callback error]', e);
    return res.status(500).send('erro na instalação');
  }
});

// ===== verify proxy + cálculo de frete =====
const proxyPath = `/${SHOPIFY_APP_PROXY_PREFIX}/${SHOPIFY_APP_PROXY_SUBPATH}`;
app.all('/apps/shipping-quotes', async (req, res) => {
    const cep = req.query.cep;
    const skus = req.query.skus?.split(',') || [];
    const quantities = req.query.quantities?.split(',').map(q => parseInt(q, 10)) || [];
    const total = parseFloat(req.query.total) || 0;
    const orderId = req.query.order_id || '129339217';
  
    // Aqui chama a função que consulta a API da Yampi
    const fretes = await calcularFreteYampi(cep, skus, quantities, total, orderId);
    res.json(fretes);
  });
app.all(proxyPath, async (req, res) => {
  try {
    if (DISABLE_PROXY_SIGNATURE_CHECK !== 'true') {
      const ok = verifyShopifyProxy(req.query, SHOPIFY_API_SECRET);
      if (!ok) return res.status(401).json({ error: 'Invalid proxy signature' });
    }

    const cep = String((req.method === 'GET' ? req.query.cep : req.body.cep) || '').replace(/\D/g, '');
    if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido' });

    const totalParam = (req.method === 'GET' ? req.query.total : req.body.total);
    const total = totalParam != null ? Number(totalParam) : undefined;

    let skusRaw = (req.method === 'GET' ? (req.query.skus ?? req.query.skus_ids) : (req.body.skus ?? req.body.skus_ids));
    let quantitiesRaw = (req.method === 'GET' ? req.query.quantities : req.body.quantities);
    const toArr = (v) => Array.isArray(v) ? v : (v == null ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
    const skusArr = toArr(skusRaw);
    const qtyArr = toArr(quantitiesRaw).map(Number);
    if (!skusArr.length || skusArr.length !== qtyArr.length) {
      return res.status(400).json({ error: 'Itens ausentes ou mal formatados' });
    }

    const ids = [];
    for (const s of skusArr) {
      if (/^\d+$/.test(s)) ids.push(Number(s)); else {
        const id = skuMap.getId(s);
        if (!id) return res.status(400).json({ error: `SKU sem ID cadastrado na Yampi: ${s}` });
        ids.push(id);
      }
    }

    const key = cacheKey({ cep, ids, qtys: qtyArr, total });
    const cached = quoteCache.get(key);
    if (cached && (Date.now() - cached.at) < (Number(CACHE_TTL_MS)||300000)) {
      return res.json({ data: cached.data, cached: true });
    }

    // order_id fixo – ajuste aqui se quiser
    const ORDER_ID_HARDCODED = 129339217;

    const raw = await calcularFreteYampi({
      alias: YAMPI_ALIAS,
      zipcode: cep,
      total,
      skusIds: ids,
      quantities: qtyArr,
      orderId: ORDER_ID_HARDCODED
    });

    const data = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    quoteCache.set(key, { at: Date.now(), data });
    return res.json({ data });
  } catch (e) {
    console.error('[shipping-quotes] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// ===== start =====
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Frete Yampi backend rodando em :${port}`);
});
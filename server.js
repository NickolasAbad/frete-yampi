import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { verifyShopifyProxy } from './verifyProxy.js';
import { calcularFreteYampi } from './yampi.js';
import { YampiSkuMap } from './yampiCatalog.js';

const app = express();
app.use(express.json());
app.use(cors());

const {
  SHOPIFY_API_SECRET,
  SHOPIFY_APP_PROXY_PREFIX = 'apps',
  SHOPIFY_APP_PROXY_SUBPATH = 'shipping-quotes',
  DISABLE_PROXY_SIGNATURE_CHECK = 'false',
  YAMPI_ALIAS,
  CACHE_TTL_MS = '300000',
  ADMIN_TOKEN
} = process.env;

// ===== SKU map (hidrata catálogo Yampi) =====
const skuMap = new YampiSkuMap(YAMPI_ALIAS, { refreshMs: 15 * 60 * 1000 });
await skuMap.bootstrap(); // carrega seed (se houver) e tenta hidratação

// ===== cache em memória para cotações =====
const quoteCache = new Map();
const TTL = Number(CACHE_TTL_MS) || 300000;

function makeCacheKey({ cep, ids, qtys, total }) {
  return JSON.stringify({ cep, ids, qtys, total });
}

function getFromCache(key) {
  const item = quoteCache.get(key);
  if (!item) return null;
  const { at, data } = item;
  if (Date.now() - at > TTL) { quoteCache.delete(key); return null; }
  return data;
}

function setCache(key, data) {
  quoteCache.set(key, { at: Date.now(), data });
}

// ===== health/version =====
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/version', (req, res) => res.json({ version: '1.0.0' }));

// ===== admin endpoints =====
app.post('/admin/refresh-skus', async (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const count = await skuMap.hydrateOnce();
    return res.json({ ok: true, count });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/admin/sku/:sku', (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const sku = String(req.params.sku || '').trim();
  return res.json({ sku, id: skuMap.getId(sku) ?? null });
});

// ===== App Proxy endpoint =====
const proxyPath = `/${SHOPIFY_APP_PROXY_PREFIX}/${SHOPIFY_APP_PROXY_SUBPATH}`;
app.all(proxyPath, async (req, res) => {
  try {
    // 1) Verificar assinatura do App Proxy
    if (DISABLE_PROXY_SIGNATURE_CHECK !== 'true') {
      const ok = verifyShopifyProxy(req.query, SHOPIFY_API_SECRET);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid proxy signature' });
      }
    }

    // 2) Inputs
    const cep = String((req.method === 'GET' ? req.query.cep : req.body.cep) || '').replace(/\D/g, '');
    if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido' });

    const totalParam = (req.method === 'GET' ? req.query.total : req.body.total);
    const total = totalParam != null ? Number(totalParam) : undefined;

    // Aceita `skus` (textuais) OU `skus_ids` (numéricos). Também aceita arrays ou string separada por vírgulas.
    let skusRaw = (req.method === 'GET' ? (req.query.skus ?? req.query.skus_ids) : (req.body.skus ?? req.body.skus_ids));
    let quantitiesRaw = (req.method === 'GET' ? req.query.quantities : req.body.quantities);

    const toArr = (v) => Array.isArray(v) ? v : (v == null ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
    const skusArr = toArr(skusRaw);
    const qtyArr = toArr(quantitiesRaw).map(Number);

    if (!skusArr.length || skusArr.length !== qtyArr.length) {
      return res.status(400).json({ error: 'Itens ausentes ou mal formatados' });
    }

    // 3) Resolver IDs numéricos para a Yampi
    const ids = [];
    for (const s of skusArr) {
      if (/^\d+$/.test(s)) {
        ids.push(Number(s)); // já é ID numérico
      } else {
        const id = skuMap.getId(s);
        if (!id) return res.status(400).json({ error: `SKU sem ID cadastrado na Yampi: ${s}` });
        ids.push(id);
      }
    }

    // 4) Cache
    const key = makeCacheKey({ cep, ids, qtys: qtyArr, total });
    const cached = getFromCache(key);
    if (cached) return res.json({ data: cached, cached: true });

    // 5) Chamada Yampi
    const orderIdParam = req.method === 'GET' ? req.query.order_id : req.body.order_id;
    const orderId = orderIdParam != null ? Number(orderIdParam) : undefined;
    
    const data = await calcularFreteYampi({
      alias: YAMPI_ALIAS,
      zipcode: cep,
      total,
      skusIds: ids,
      quantities: qtyArr,
      orderId: 129339217
    });
    

    setCache(key, data);
    return res.json({ data });
  } catch (e) {
    console.error('[shipping-quotes] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// ===== start =====
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Frete Yampi backend rodando em :${port} – proxy ${proxyPath}`);
});
import fetch from 'node-fetch';
import fs from 'fs';

const BASE = 'https://api.dooki.com.br/v2';

async function yampiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'User-Token': process.env.YAMPI_USER_TOKEN,
      'User-Secret-Key': process.env.YAMPI_SECRET_KEY
    }
  });
  if (!res.ok) throw new Error(`[Yampi GET ${res.status}] ${await res.text()}`);
  return res.json();
}

export class YampiSkuMap {
  constructor(alias, { refreshMs = 15 * 60 * 1000 } = {}) {
    this.alias = alias;
    this.refreshMs = refreshMs;
    this.map = new Map(); // sku_text -> sku_id
    this.timer = null;
  }

  getId(skuText) {
    if (!skuText) return undefined;
    const key = String(skuText).trim();
    return this.map.get(key) ?? this.map.get(key.toUpperCase()) ?? this.map.get(key.toLowerCase());
  }

  async bootstrap() {
    // 1) tentar seed local (opcional)
    const seedPath = process.env.SKU_SEED_FILE;
    if (seedPath && fs.existsSync(seedPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        if (Array.isArray(raw)) {
          raw.forEach((r) => {
            if (r && r.sku && r.id) this.map.set(String(r.sku).trim(), Number(r.id));
          });
        } else if (raw && typeof raw === 'object') {
          for (const [sku, id] of Object.entries(raw)) this.map.set(String(sku).trim(), Number(id));
        }
        console.log(`[SKU MAP] seed carregado (${this.map.size} itens)`);
      } catch (e) {
        console.warn('[SKU MAP] falha ao ler seed:', e.message);
      }
    }
    // 2) hidratar online
    try {
      const count = await this.hydrateOnce();
      console.log(`[SKU MAP] hidratação completa (${count} SKUs)`);
    } catch (e) {
      console.warn('[SKU MAP] hidratação inicial falhou:', e.message);
    }
    // 3) auto refresh
    this.startAutoRefresh();
  }

  startAutoRefresh() {
    const run = async () => {
      try {
        const count = await this.hydrateOnce();
        console.log(`[SKU MAP] atualizado (${count} SKUs)`);
      } catch (e) {
        console.warn('[SKU MAP] atualização falhou:', e.message);
      } finally {
        this.timer = setTimeout(run, this.refreshMs);
      }
    };
    if (!this.timer) this.timer = setTimeout(run, this.refreshMs);
  }

  stopAutoRefresh() { if (this.timer) clearTimeout(this.timer); }

  async hydrateOnce({ pageStart = 1, limit = 100, maxPages = 1000 } = {}) {
    let page = pageStart;
    let total = 0;
    for (;;) {
      const resp = await yampiGet(`/${this.alias}/catalog/products?include=skus&limit=${limit}&page=${page}`);
      const list = resp?.data || [];
      for (const p of list) {
        const skus = (p?.skus?.data) || p?.skus || [];
        if (Array.isArray(skus)) {
          for (const s of skus) {
            if (s?.sku && s?.id != null) {
              const key = String(s.sku).trim();
              const id = Number(s.id);
              this.map.set(key, id);
              this.map.set(key.toUpperCase(), id);
              this.map.set(key.toLowerCase(), id);
              total++;
            }
          }
        }
      }
      const totalPages = Number(resp?.meta?.pagination?.total_pages || page);
      if (!list.length || page >= totalPages || page - pageStart + 1 >= maxPages) break;
      page += 1;
    }
    return total;
  }
}
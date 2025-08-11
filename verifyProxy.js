import crypto from 'crypto';

// Verificação de assinatura do App Proxy do Shopify
// Calcula HMAC-SHA256 sobre os params (sem o `signature`), ordenados por chave e concatenados como `key=value` sem separador.
export function verifyShopifyProxy(query, secret) {
  if (!secret) return false;
  const { signature, ...params } = query || {};
  if (!signature) return false;
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return digest === signature;
}
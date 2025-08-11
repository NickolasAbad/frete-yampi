import fetch from 'node-fetch';

const BASE = 'https://api.dooki.com.br/v2';

export async function calcularFreteYampi({ alias, zipcode, total, skusIds, quantities, origin = 'cart_drawer', utm_email, orderId }) {
    const url = `${BASE}/${alias}/logistics/shipping-costs`;
    const body = { zipcode, total, origin, utm_email, skus_ids: skusIds, quantities };
    if (orderId != null) body.order_id = orderId;  

    console.log('body', body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Token': process.env.YAMPI_USER_TOKEN,
      'User-Secret-Key': process.env.YAMPI_SECRET_KEY
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Yampi ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json?.data ?? json; // docs retornam { data: { ...rate } }
}
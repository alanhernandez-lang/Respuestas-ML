const { redis, withLockRetry } = require('./redis');

const API_BASE = 'https://api.mercadolibre.com';
const TOKEN_KEY = 'ml:token';

async function loadTokenStore() {
  return redis.get(TOKEN_KEY);
}

async function saveTokenStore(store) {
  await redis.set(TOKEN_KEY, store);
}

async function refreshAccessToken() {
  // El refresh_token de Mercado Libre se invalida en cuanto se usa una vez: si dos
  // llamadas refrescaran al mismo tiempo, la que "pierda" se quedaría con un token
  // roto. El lock serializa esto entre todas las instancias serverless.
  return withLockRetry('lock:ml:token-refresh', 15000, 20000, async () => {
    // Re-checar DESPUÉS de tomar el lock: si otra invocación ya refrescó mientras
    // esperábamos el lock, usamos ese token nuevo en vez de refrescar por segunda vez.
    const current = await loadTokenStore();
    if (current && current.expires_at > Date.now()) {
      return current;
    }

    const refreshToken = current?.refresh_token || process.env.ML_REFRESH_TOKEN;

    const res = await withTimeout(
      fetch(`${API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.ML_CLIENT_ID,
          client_secret: process.env.ML_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(20000),
      }),
      22000,
      'No se pudo refrescar el token de Mercado Libre (timeout)',
    );

    if (!res.ok) {
      throw new Error(`No se pudo refrescar el token de Mercado Libre (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    // Mercado Libre rota el refresh_token en cada uso: hay que persistir el nuevo o la
    // siguiente sincronización fallará porque el refresh_token anterior queda invalidado.
    const newStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id,
      expires_at: Date.now() + (data.expires_in - 120) * 1000,
    };
    await saveTokenStore(newStore);
    return newStore;
  });
}

async function getAccessToken() {
  const store = await loadTokenStore();
  if (store && store.expires_at > Date.now()) {
    return store;
  }
  return refreshAccessToken();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Además de la señal de abort en el propio fetch, forzamos un límite de tiempo desde
// afuera con setTimeout: así, aunque el fetch no honre el abort (una conexión colgada
// a medio camino, por ejemplo), el código sigue adelante en vez de quedarse esperando
// para siempre y trabando toda la sincronización.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mlFetch(token, urlPath, attempt = 1) {
  let res;
  try {
    res = await withTimeout(
      fetch(`${API_BASE}${urlPath}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20000),
      }),
      22000,
      `ML API no respondió a tiempo en ${urlPath}`,
    );
  } catch (err) {
    // Errores de red transitorios (wifi inestable, laptop despertando de suspensión, etc.)
    // no deben tirar toda la sincronización: reintentamos un par de veces con backoff.
    if (attempt < 3) {
      await sleep(500 * attempt);
      return mlFetch(token, urlPath, attempt + 1);
    }
    throw err;
  }
  if (!res.ok) {
    // 429 = "local_rate_limited": Mercado Libre limita las consultas por CUENTA
    // vendedora, no solo por app — si alguien está navegando ml.com.mx al mismo
    // tiempo, esa cuota se comparte. Le damos más tiempo de recuperación que a un
    // 500 normal antes de reintentar.
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      const backoff = res.status === 429 ? 1500 * attempt : 500 * attempt;
      await sleep(backoff);
      return mlFetch(token, urlPath, attempt + 1);
    }
    const body = await res.text();
    const err = new Error(`ML API ${res.status} en ${urlPath}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function fetchUnreadPacks(token) {
  return mlFetch(token, '/messages/unread?role=seller&tag=post_sale');
}

// Este endpoint pagina los mensajes (la propia documentación de ML muestra un
// default de apenas 10 por página) — sin `limit`/`offset` solo llegaba la primera
// página, y en conversaciones largas el resto del historial se perdía en
// silencio. Pedimos páginas grandes y, si `paging.total` dice que falta más,
// seguimos pidiendo hasta juntarlo todo (con un tope de vueltas por si acaso).
async function fetchPackMessages(token, packId, sellerId) {
  // 50 es el default/máximo típico en varios endpoints de listado de ML — no hay
  // un máximo documentado específico para este, así que nos quedamos con un valor
  // conservador en vez de arriesgar un 400 por pedir un límite que no soporte.
  const PAGE_SIZE = 50;
  const PAGE_GUARD = 20;
  const path = (offset) => `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale&mark_as_read=false&limit=${PAGE_SIZE}&offset=${offset}`;

  const first = await mlFetch(token, path(0));
  let messages = first.messages || [];
  const total = first.paging?.total ?? messages.length;
  const pageSize = first.paging?.limit || PAGE_SIZE;

  let guard = 0;
  while (messages.length < total && guard < PAGE_GUARD) {
    guard++;
    const next = await mlFetch(
      token,
      `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale&mark_as_read=false&limit=${pageSize}&offset=${messages.length}`,
    );
    const nextMessages = next.messages || [];
    if (!nextMessages.length) break; // por si `total` viniera mal, para no dar vueltas de más
    messages = messages.concat(nextMessages);
  }

  return { ...first, messages };
}

// A diferencia de fetchPackMessages (que usa mark_as_read=false a propósito, para no
// marcar nada leído solo por sincronizar), esta SÍ marca la conversación como leída en
// Mercado Libre — se llama solo después de publicar una respuesta real.
function markPackMessagesRead(token, packId, sellerId) {
  return mlFetch(token, `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale&mark_as_read=true`);
}

function fetchPackDetail(token, packId) {
  return mlFetch(token, `/packs/${packId}`);
}

function fetchOrderDetail(token, orderId) {
  return mlFetch(token, `/orders/${orderId}`);
}

// El link real y exacto a la publicación (con su slug de SEO) solo viene en el recurso
// completo del ítem, no en el resumen embebido dentro de la orden.
function fetchItemDetail(token, itemId) {
  return mlFetch(token, `/items/${itemId}`);
}

function fetchClaimDetail(token, claimId) {
  return mlFetch(token, `/post-purchase/v1/claims/${claimId}`);
}

function fetchClaimMessages(token, claimId) {
  return mlFetch(token, `/post-purchase/v1/claims/${claimId}/messages`);
}

// A diferencia de conversation_status (que solo dice si el chat está bloqueado
// AHORA MISMO por una mediación en curso), esto busca cualquier reclamo ligado a
// la orden sin importar si ya se cerró — así detectamos mediaciones ya resueltas
// que Mercado Libre deja de marcar como "blocked" una vez terminadas.
function fetchClaimsByOrder(token, orderId) {
  return mlFetch(token, `/post-purchase/v1/claims/search?order_id=${orderId}`);
}

async function fetchAttachment(token, filename, siteId, attempt = 1) {
  let res;
  try {
    res = await withTimeout(
      fetch(`${API_BASE}/messages/attachments/${filename}?tag=post_sale&site_id=${siteId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20000),
      }),
      22000,
      `ML API no respondió a tiempo bajando el adjunto ${filename}`,
    );
  } catch (err) {
    if (attempt < 3) {
      await sleep(500 * attempt);
      return fetchAttachment(token, filename, siteId, attempt + 1);
    }
    throw err;
  }
  if (!res.ok) {
    if (res.status >= 500 && attempt < 3) {
      await sleep(500 * attempt);
      return fetchAttachment(token, filename, siteId, attempt + 1);
    }
    throw new Error(`ML API ${res.status} bajando el adjunto ${filename}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: res.headers.get('content-type') };
}

// Sube un archivo (foto o PDF) que el VENDEDOR quiere adjuntar a su respuesta. Es un
// paso separado de sendPackMessage a propósito: primero se sube el archivo (ML lo
// guarda temporalmente y devuelve un `filename` hasheado), y ese filename se manda
// después dentro de attachments al publicar el mensaje — igual que ya hacíamos al
// revés para bajar los adjuntos que manda el cliente (fetchAttachment).
async function uploadAttachment(token, buffer, filename, mimeType, siteId) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);

  const res = await withTimeout(
    fetch(`${API_BASE}/messages/attachments?tag=post_sale&site_id=${siteId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    }),
    32000,
    'ML API no respondió a tiempo al subir el adjunto',
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ML API ${res.status} al subir el adjunto: ${body}`);
  }

  return res.json();
}

// A diferencia de las demás llamadas (solo lectura), esta SÍ manda un mensaje real
// al comprador. No lleva reintentos automáticos en caso de error: si falla, es mejor
// que la persona vea el error y decida reintentar a mano en vez de mandar el mensaje
// dos veces por una reintento silencioso.
async function sendPackMessage(token, packId, sellerId, buyerId, text, attachments) {
  const res = await withTimeout(
    fetch(`${API_BASE}/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: { user_id: String(sellerId) },
        to: { user_id: String(buyerId) },
        text,
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    }),
    22000,
    'ML API no respondió a tiempo al publicar el mensaje',
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ML API ${res.status} al enviar el mensaje: ${body}`);
  }

  return res.json();
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = {
  getAccessToken,
  fetchUnreadPacks,
  fetchPackMessages,
  fetchPackDetail,
  fetchOrderDetail,
  fetchItemDetail,
  fetchClaimDetail,
  fetchClaimMessages,
  fetchClaimsByOrder,
  fetchAttachment,
  uploadAttachment,
  sendPackMessage,
  markPackMessagesRead,
  mapWithConcurrency,
};

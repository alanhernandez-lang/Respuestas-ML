require('dotenv').config();
const path = require('path');
const express = require('express');
const {
  getAccessToken,
  fetchUnreadPacks,
  fetchPackMessages,
  fetchPackDetail,
  fetchOrderDetail,
  fetchItemDetail,
  fetchClaimDetail,
  fetchClaimMessages,
  fetchAttachment,
  sendPackMessage,
  markPackMessagesRead,
  mapWithConcurrency,
} = require('./lib/ml');
const { generateDraftAnswer } = require('./lib/agent');
const { redis, withLock } = require('./lib/redis');

const CLAIM_ROLE_LABELS = { mediator: 'Mediador (ML)', respondent: 'Vendedor (tú)', complainant: 'Cliente' };

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '');
}

async function resolveMediation(token, claimIds) {
  if (!claimIds || claimIds.length === 0) return null;
  const claimId = claimIds[0];
  try {
    const [detail, messages] = await Promise.all([
      fetchClaimDetail(token, claimId),
      fetchClaimMessages(token, claimId),
    ]);
    const sortedMessages = (messages || [])
      .slice()
      .sort((a, b) => new Date(a.date_created) - new Date(b.date_created))
      .map((m) => ({
        role: m.sender_role,
        roleLabel: CLAIM_ROLE_LABELS[m.sender_role] || m.sender_role,
        text: stripHtml(m.message),
        date: m.date_created,
      }));
    return {
      claimId,
      status: detail.status,
      stage: detail.stage,
      reasonId: detail.reason_id,
      resolution: detail.resolution,
      messages: sortedMessages,
    };
  } catch (err) {
    return { claimId, error: err.message };
  }
}

const SELLER_ID = process.env.ML_SELLER_ID;

// El caché completo vive en un hash de Redis (un campo por packId) en vez de un solo
// archivo JSON: así "regenerar borrador", "guardar edición" y "publicar" pueden tocar
// SOLO su propio pack (HSET de un campo) sin tener que releer/reescribir los demás
// ~170, y sin arriesgarse a pisar lo que otra operación concurrente acaba de guardar.
const CACHE_PACKS_KEY = 'ml:cache:packs';
const CACHE_META_KEY = 'ml:cache:meta';

function parseMaybeJson(value) {
  if (value == null) return value;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function loadCache() {
  const [packsHash, meta] = await Promise.all([
    redis.hgetall(CACHE_PACKS_KEY),
    redis.get(CACHE_META_KEY),
  ]);
  const packs = {};
  for (const [packId, value] of Object.entries(packsHash || {})) {
    packs[packId] = parseMaybeJson(value);
  }
  return { syncedAt: parseMaybeJson(meta)?.syncedAt || null, packs };
}

async function loadPackEntry(packId) {
  const value = await redis.hget(CACHE_PACKS_KEY, packId);
  return value == null ? null : parseMaybeJson(value);
}

async function savePackEntry(packId, entry) {
  await redis.hset(CACHE_PACKS_KEY, { [packId]: entry });
}

// Escribe varios packs en una sola ida y vuelta (un HSET con N campos), en vez de
// N escrituras sueltas — se usa después de un sync completo.
async function savePacksBulk(packsById) {
  const fields = Object.keys(packsById);
  if (!fields.length) return;
  await redis.hset(CACHE_PACKS_KEY, packsById);
}

async function saveMeta(meta) {
  await redis.set(CACHE_META_KEY, meta);
}

function buyerDisplayName(buyer) {
  if (!buyer) return 'Cliente desconocido';
  const fullName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim();
  return fullName || buyer.nickname || `Usuario ${buyer.id}`;
}

async function resolvePackInfo(token, packId, cache) {
  const cached = cache.packs[packId]?.info;
  // Los packs guardados antes de que existiera `buyerId`/`itemLinks` no los tienen en
  // caché: se re-consultan una vez más para completarlos, en vez de quedarse sin ellos
  // para siempre.
  if (cached && cached.buyerId && cached.itemLinks) return cached;

  // Cuando una orden no forma parte de un pack real de Mercado Libre, la API de
  // mensajes usa el order_id como si fuera pack_id y /packs/{id} responde 404.
  // En ese caso tratamos el id como order_id directamente.
  let orderId;
  try {
    const packDetail = await fetchPackDetail(token, packId);
    orderId = packDetail.orders?.[0]?.id;
  } catch (err) {
    if (err.status === 404) {
      orderId = packId;
    } else {
      throw err;
    }
  }

  let buyerName = 'Cliente desconocido';
  let itemTitles = [];
  let itemLinks = [];
  let buyerId = null;

  if (orderId) {
    const order = await fetchOrderDetail(token, orderId);
    buyerName = buyerDisplayName(order.buyer);
    itemTitles = (order.order_items || []).map((oi) => oi.item?.title).filter(Boolean);
    buyerId = order.buyer?.id || null;

    // El permalink real (con su slug de SEO) solo viene en el recurso completo del
    // ítem, no en el resumen embebido dentro de la orden — por eso se consulta aparte.
    const itemIds = (order.order_items || []).map((oi) => oi.item?.id).filter(Boolean);
    itemLinks = (await Promise.all(itemIds.map(async (itemId) => {
      try {
        const item = await fetchItemDetail(token, itemId);
        return { title: item.title, url: item.permalink };
      } catch {
        return null;
      }
    }))).filter(Boolean);
  }

  return { orderId: orderId || null, buyerName, itemTitles, itemLinks, buyerId };
}

async function syncPack(token, packEntry, cache) {
  const packId = packEntry.resource.match(/\/packs\/(\d+)\//)[1];
  const [info, messagesResp] = await Promise.all([
    resolvePackInfo(token, packId, cache),
    fetchPackMessages(token, packId, SELLER_ID),
  ]);

  const messages = (messagesResp.messages || [])
    .slice()
    .sort((a, b) => new Date(a.message_date.created) - new Date(b.message_date.created))
    .map((m) => ({
      sender: String(m.from.user_id) === String(SELLER_ID) ? 'vendedor' : 'cliente',
      text: m.text || (m.message_attachments ? '[imagen adjunta]' : ''),
      date: m.message_date.created,
      hasAttachment: Boolean(m.message_attachments),
      attachments: (m.message_attachments || [])
        .filter((a) => a.type?.startsWith('image/'))
        .map((a) => ({ filename: a.filename, mimeType: a.type, siteId: m.site_id })),
    }));

  // Se usa para que el agente de IA sepa si una garantía (30 días) sigue vigente,
  // sin tener que adivinarlo a partir del tono del cliente.
  const orderCreationDate = (messagesResp.messages || [])
    .find((m) => m.data?.order_creation_date)?.data?.order_creation_date || null;

  const lastQuestion = [...messages].reverse().find((m) => m.sender === 'cliente') || null;
  const lastAnswer = [...messages].reverse().find((m) => m.sender === 'vendedor') || null;
  const conversationStatus = messagesResp.conversation_status?.status || null;
  const mediation = conversationStatus === 'blocked'
    ? await resolveMediation(token, messagesResp.conversation_status?.claim_ids)
    : null;
  const status = mediation
    ? 'mediacion'
    : (lastAnswer && lastQuestion && new Date(lastAnswer.date) > new Date(lastQuestion.date)
      ? 'respondido'
      : 'pendiente');

  return {
    packId,
    orderId: info.orderId,
    orderUrl: info.orderId ? `https://www.mercadolibre.com.mx/ventas/${info.orderId}/detalle` : null,
    buyerName: info.buyerName,
    buyerId: info.buyerId,
    itemTitles: info.itemTitles,
    itemLinks: info.itemLinks || [],
    unreadCount: packEntry.count,
    status,
    lastQuestion,
    lastAnswer,
    messages,
    orderCreationDate,
    conversationStatus,
    mediation,
  };
}

// El borrador de IA sigue siendo válido mientras nadie haya hecho una pregunta
// nueva desde que se generó, así que solo se regenera cuando cambia lastQuestion.
// `touched` acumula los packIds que de verdad cambiaron este ciclo, para que
// runSync() solo reescriba esos en Redis (no los ~170 completos cada vez).
async function attachDrafts(packs, previousCache, token, touched) {
  const pendingEntries = Object.values(packs).filter((p) => p.record.status === 'pendiente');
  const isEntryFresh = (entry) => {
    const questionDate = entry.record.lastQuestion?.date || null;
    const previousDraft = previousCache.packs[entry.record.packId]?.record?.draftAnswer;
    return Boolean(previousDraft && !previousDraft.error && previousDraft.forQuestionDate === questionDate);
  };
  const pendingToGenerate = pendingEntries.filter((entry) => !isEntryFresh(entry)).length;
  if (pendingToGenerate > 0) console.log(`Generando ${pendingToGenerate} borrador(es) IA...`);
  let ok = 0;
  let failed = 0;
  // OJO: este mapWithConcurrency debe correr SIEMPRE para TODOS los pendientes, incluso
  // cuando nadie necesita un borrador nuevo — es el único lugar donde se copia el
  // draftAnswer ya generado hacia el objeto `record` fresco de este ciclo. Si se salta,
  // el borrador se "pierde" (queda undefined) aunque nunca haya dejado de ser válido.
  await mapWithConcurrency(pendingEntries, 3, async (entry) => {
    const record = entry.record;
    const questionDate = record.lastQuestion?.date || null;
    const previousDraft = previousCache.packs[record.packId]?.record?.draftAnswer;
    const isFresh = previousDraft && !previousDraft.error && previousDraft.forQuestionDate === questionDate;
    if (isFresh) {
      record.draftAnswer = previousDraft;
      return;
    }
    try {
      const { text } = await generateDraftAnswer({
        buyerName: record.buyerName,
        itemTitles: record.itemTitles,
        messages: record.messages,
        orderCreationDate: record.orderCreationDate,
        token,
      });
      record.draftAnswer = { text, generatedAt: new Date().toISOString(), forQuestionDate: questionDate };
      ok++;
    } catch (err) {
      console.warn('Error generando borrador IA para pack', record.packId, err.message);
      record.draftAnswer = { error: err.message, forQuestionDate: questionDate };
      failed++;
    }
    touched.add(record.packId);
  });
  if (pendingToGenerate > 0) console.log(`Borradores IA listos: ${ok} ok, ${failed} con error.`);
}

async function runSyncInner() {
  const tokenStore = await getAccessToken();
  const token = tokenStore.access_token;
  const cache = await loadCache();

  const unread = await fetchUnreadPacks(token);
  const results = await mapWithConcurrency(unread.results, 5, (entry) => syncPack(token, entry, cache));

  // Arrancamos con todo lo que ya conocíamos: las conversaciones nunca se borran,
  // aunque Mercado Libre deje de reportarlas como "no leídas" (porque alguien ya
  // las abrió directamente en ML). Solo se actualizan las que vienen frescas en
  // este ciclo; el resto se queda tal cual estaba (y no se reescribe en Redis).
  const packs = { ...cache.packs };
  const touched = new Set();
  let errors = 0;
  results.forEach((r) => {
    if (r.error) {
      errors++;
      console.warn('Error en pack:', r.error);
      // Como `packs` ya arranca con todo lo anterior, un error transitorio
      // simplemente no lo toca — se conserva el último dato bueno.
      return;
    }
    packs[r.packId] = { info: { orderId: r.orderId, buyerName: r.buyerName, buyerId: r.buyerId, itemTitles: r.itemTitles, itemLinks: r.itemLinks }, record: r };
    touched.add(r.packId);
  });

  await attachDrafts(packs, cache, token, touched);

  if (touched.size) {
    const toWrite = {};
    touched.forEach((id) => { toWrite[id] = packs[id]; });
    await savePacksBulk(toWrite);
  }
  const syncedAt = new Date().toISOString();
  await saveMeta({ syncedAt });
  return { syncedAt, totalPacks: Object.keys(packs).length, errors };
}

// El sync completo toca (potencialmente) todos los packs a la vez, así que necesita
// el lock global — si dos ciclos corrieran encimados, el que termine después podría
// pisar drafts que el otro acababa de generar.
function runSync() {
  return withLock('lock:ml:sync', 90000, runSyncInner);
}

async function getPackEntryOrThrow(packId) {
  const entry = await loadPackEntry(packId);
  if (!entry) {
    const err = new Error(`No se encontró el pack ${packId} en caché`);
    err.status = 404;
    throw err;
  }
  return entry;
}

async function regenerateDraftInner(packId) {
  const entry = await getPackEntryOrThrow(packId);
  const record = entry.record;
  const { access_token: token } = await getAccessToken();
  const { text } = await generateDraftAnswer({
    buyerName: record.buyerName,
    itemTitles: record.itemTitles,
    messages: record.messages,
    orderCreationDate: record.orderCreationDate,
    token,
  });
  record.draftAnswer = {
    text,
    generatedAt: new Date().toISOString(),
    forQuestionDate: record.lastQuestion?.date || null,
  };
  await savePackEntry(packId, entry);
  return record.draftAnswer;
}

function regenerateDraft(packId) {
  return withLock(`lock:pack:${packId}`, 60000, () => regenerateDraftInner(packId));
}

async function saveDraftTextInner(packId, text) {
  const entry = await getPackEntryOrThrow(packId);
  const record = entry.record;
  record.draftAnswer = {
    text,
    generatedAt: record.draftAnswer?.generatedAt || new Date().toISOString(),
    forQuestionDate: record.draftAnswer?.forQuestionDate || record.lastQuestion?.date || null,
    edited: true,
  };
  await savePackEntry(packId, entry);
  return record.draftAnswer;
}

function saveDraftText(packId, text) {
  return withLock(`lock:pack:${packId}`, 15000, () => saveDraftTextInner(packId, text));
}

async function publishAnswerInner(packId) {
  const entry = await getPackEntryOrThrow(packId);
  const record = entry.record;
  if (!record.draftAnswer?.text) {
    const err = new Error('No hay un borrador listo para publicar');
    err.status = 400;
    throw err;
  }

  const { access_token: token } = await getAccessToken();

  // Los packs "pendiente" que alguien ya leyó en ML (sin responder) dejan de venir en
  // el sync automático (solo trae "no leídos"), así que pueden no tener buyerId todavía.
  // Antes de rendirnos, lo buscamos al vuelo con el orderId que ya tenemos guardado.
  if (!record.buyerId && record.orderId) {
    try {
      const order = await fetchOrderDetail(token, record.orderId);
      record.buyerId = order.buyer?.id || null;
      if (entry.info) entry.info.buyerId = record.buyerId;
    } catch {
      // si falla, sigue sin buyerId y cae al error de abajo
    }
  }
  if (!record.buyerId) {
    const err = new Error('No se pudo identificar al comprador de esta conversación');
    err.status = 400;
    throw err;
  }

  const text = record.draftAnswer.text;
  await sendPackMessage(token, packId, SELLER_ID, record.buyerId, text);

  // Marcamos la conversación como leída en Mercado Libre: por defecto nuestra app
  // sincroniza con mark_as_read=false (para no marcar nada leído solo por consultar),
  // así que sin esto, ML seguiría mostrando el mensaje como pendiente aunque ya se
  // haya contestado de verdad. Si esto falla, no tumbamos la respuesta ya enviada.
  try {
    await markPackMessagesRead(token, packId, SELLER_ID);
  } catch (err) {
    console.warn('No se pudo marcar como leído el pack', packId, err.message);
  }

  // Reflejamos el envío de inmediato en el caché local (en vez de esperar al próximo
  // sync automático) para que la conversación desaparezca de "Borradores IA" al instante.
  const now = new Date().toISOString();
  record.messages.push({ sender: 'vendedor', text, date: now, hasAttachment: false, attachments: [] });
  record.lastAnswer = { sender: 'vendedor', text, date: now, hasAttachment: false };
  record.status = 'respondido';
  record.draftAnswer = null;

  await savePackEntry(packId, entry);
  return record;
}

function publishAnswer(packId) {
  return withLock(`lock:pack:${packId}`, 30000, () => publishAnswerInner(packId));
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Ya no hay un `isSyncing` en memoria: el lock de runSync() (vía withLock) ya
// resuelve eso entre instancias serverless. El último error sí necesita vivir
// en Redis (no en una variable de proceso) para que GET /api/messages lo vea
// sin importar qué instancia atendió el sync que falló.
const LAST_SYNC_ERROR_KEY = 'ml:cache:lastSyncError';

async function loadLastSyncError() {
  return redis.get(LAST_SYNC_ERROR_KEY);
}

async function saveLastSyncError(message) {
  if (message == null) {
    await redis.del(LAST_SYNC_ERROR_KEY);
  } else {
    await redis.set(LAST_SYNC_ERROR_KEY, message);
  }
}

app.get('/api/messages', async (req, res) => {
  try {
    const [cache, lastSyncError] = await Promise.all([loadCache(), loadLastSyncError()]);
    const records = Object.values(cache.packs)
      .map((p) => p.record)
      .sort((a, b) => {
        const da = a.lastQuestion?.date || 0;
        const db = b.lastQuestion?.date || 0;
        return new Date(db) - new Date(da);
      });
    res.json({ syncedAt: cache.syncedAt, records, lastSyncError });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const summary = await runSync();
    await saveLastSyncError(null);
    res.json(summary);
  } catch (err) {
    console.error(err);
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    await saveLastSyncError(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/:packId/regenerate-draft', async (req, res) => {
  try {
    const draftAnswer = await regenerateDraft(req.params.packId);
    res.json({ draftAnswer });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/messages/:packId/draft', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'El texto no puede estar vacío' });
    }
    const draftAnswer = await saveDraftText(req.params.packId, text);
    res.json({ draftAnswer });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/messages/:packId/publish', async (req, res) => {
  try {
    const record = await publishAnswer(req.params.packId);
    res.json({ record });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/attachments/:filename', async (req, res) => {
  try {
    const { access_token: token } = await getAccessToken();
    const siteId = req.query.siteId || 'MLM';
    const { base64, mimeType } = await fetchAttachment(token, req.params.filename, siteId);
    res.set('Content-Type', mimeType || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(base64, 'base64'));
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo cargar la imagen');
  }
});

// Vercel Hobby limita su propio Cron a una vez al día, así que la sincronización
// periódica la dispara un cron externo (cron-job.org) pegándole a esta ruta cada
// ~2 minutos. El secreto evita que cualquiera en internet la dispare a mano.
app.get('/api/cron/sync', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const summary = await runSync();
    await saveLastSyncError(null);
    res.json(summary);
  } catch (err) {
    // Si otra invocación ya está sincronizando (lock tomado), no es un error real:
    // el cron externo vuelve a llamar en un par de minutos de todos modos.
    if (err.status === 409) {
      return res.status(200).json({ skipped: true, reason: err.message });
    }
    console.error('Error en sync por cron:', err);
    await saveLastSyncError(err.message);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;

// En Vercel el módulo se importa como función serverless (@vercel/node), sin
// llamar a listen(); localmente (npm start) sí necesitamos el servidor real.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Mensajes ML disponibles en http://localhost:${port}`);
  });
}

module.exports = app;

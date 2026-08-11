require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
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
} = require('./lib/ml');
const { generateDraftAnswer } = require('./lib/agent');
const { redis, withLock } = require('./lib/redis');
const { SESSION_COOKIE, verifyCredentials, createSessionToken, verifySessionToken } = require('./lib/auth');

const CLAIM_ROLE_LABELS = { mediator: 'Mediador (ML)', respondent: 'Vendedor (tú)', complainant: 'Cliente' };

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '');
}

// Ver el comentario junto a su uso en syncPackById: un reclamo/mediación/devolución
// que YA NO está bloqueando la conversación (o sea, existe `pastMediation`) significa
// que no hay nada que contestar en el chat normal, aunque el hilo se haya quedado con
// el último mensaje del cliente sin responder. Se reutiliza tanto ahí (recién
// sincronizado) como en checkPastMediation (cuando esto se descubre después, para un
// pack que ya estaba en caché como "pendiente").
//
// OJO: a propósito NO se exige pastMediation.status === 'closed' — en la práctica
// Mercado Libre no siempre manda ese campo con ese valor exacto (a veces viene null
// o con otro texto), y el badge "Tuvo mediación" ya se muestra con solo que exista
// `pastMediation` — así que basta con eso para decidir el mismo criterio en los dos
// lados y no dejar casos con el badge pero atorados en "pendiente".
function applyClosedClaimOverride(status, pastMediation) {
  return (status === 'pendiente' && pastMediation) ? 'respondido' : status;
}

async function resolveMediation(token, claimIds) {
  // Mercado Libre puede reportar la conversación como "blocked" por mediación sin
  // mandar todavía el claim_id asociado (lo vimos documentado y en casos reales).
  // Devolvemos un objeto igual (no null) para que el estado "mediación" no dependa
  // de si ya tenemos el detalle del reclamo o no.
  if (!claimIds || claimIds.length === 0) {
    return { claimId: null, type: null, status: null, stage: null, resolution: null, messages: [] };
  }
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
      // `type` distingue una devolución (type: "return") de una mediación propiamente
      // dicha o una cancelación de compra — sin esto, todo se veía genérico como
      // "Mediación" en la UI aunque en realidad fuera una devolución.
      type: detail.type || null,
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

// Bitácora: historial de quién respondió qué. A diferencia de `record.answeredBy`
// (que solo guarda la respuesta MÁS RECIENTE de cada conversación), esta lista
// conserva cada evento de publicación por separado, más nueva primero.
const ANSWER_LOG_KEY = 'app:answerlog';
const ANSWER_LOG_MAX = 1000;

async function appendAnswerLog(entry) {
  await redis.lpush(ANSWER_LOG_KEY, entry);
  await redis.ltrim(ANSWER_LOG_KEY, 0, ANSWER_LOG_MAX - 1);
}

async function loadAnswerLog() {
  const raw = await redis.lrange(ANSWER_LOG_KEY, 0, ANSWER_LOG_MAX - 1);
  return (raw || []).map(parseMaybeJson).filter(Boolean);
}

// Agrupa el historial de respuestas por texto EXACTO (recortando espacios): así el
// banco de respuestas no repite la misma respuesta usada 10 veces como 10 renglones
// distintos. `questions` guarda hasta 5 preguntas distintas que motivaron esa misma
// respuesta, para que quien la lea (persona o el propio agente de IA) entienda cuándo
// aplica.
function computeResponseBank(entries) {
  const groups = new Map();
  entries.forEach((e) => {
    const key = (e.text || '').trim().replace(/\s+/g, ' ');
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { text: e.text.trim(), count: 0, questions: [], lastUsed: e.date });
    const g = groups.get(key);
    g.count += 1;
    if (!g.lastUsed || e.date > g.lastUsed) g.lastUsed = e.date;
    if (e.question && !g.questions.includes(e.question) && g.questions.length < 5) {
      g.questions.push(e.question);
    }
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || new Date(b.lastUsed) - new Date(a.lastUsed));
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

async function syncPackById(token, packId, cache, unreadCount) {
  // El historial de mediación ya cerrada (ver checkPastMediation) se calcula aparte
  // y por separado del resto de la conversación — si no lo arrastramos aquí, cada
  // vez que este pack se vuelva a sincronizar (llega un mensaje nuevo, etc.) se
  // perdería sin que nadie lo vuelva a detectar.
  const previousRecord = cache.packs[packId]?.record;
  const [info, messagesResp] = await Promise.all([
    resolvePackInfo(token, packId, cache),
    fetchPackMessages(token, packId, SELLER_ID),
  ]);

  const messages = (messagesResp.messages || [])
    .slice()
    .sort((a, b) => new Date(a.message_date.created) - new Date(b.message_date.created))
    .map((m) => {
      // Antes solo se guardaban las fotos — un PDF adjunto (factura, constancia
      // fiscal, comprobante...) se descartaba por completo aquí y ni siquiera
      // quedaba guardado, así que no había manera de verlo ni de que el agente de
      // IA se enterara de que existía.
      const attachments = (m.message_attachments || [])
        .filter((a) => a.type?.startsWith('image/') || a.type === 'application/pdf')
        .map((a) => ({
          filename: a.filename,
          mimeType: a.type,
          siteId: m.site_id,
          kind: a.type === 'application/pdf' ? 'pdf' : 'image',
        }));
      const attachmentLabel = attachments.some((a) => a.kind === 'pdf')
        ? (attachments.some((a) => a.kind === 'image') ? '[imagen y PDF adjuntos]' : '[PDF adjunto]')
        : '[imagen adjunta]';
      return {
        sender: String(m.from.user_id) === String(SELLER_ID) ? 'vendedor' : 'cliente',
        text: m.text || (m.message_attachments ? attachmentLabel : ''),
        date: m.message_date.created,
        hasAttachment: Boolean(m.message_attachments),
        attachments,
      };
    });

  // Se usa para que el agente de IA sepa si una garantía (30 días) sigue vigente,
  // sin tener que adivinarlo a partir del tono del cliente.
  const orderCreationDate = (messagesResp.messages || [])
    .find((m) => m.data?.order_creation_date)?.data?.order_creation_date || null;

  const lastQuestion = [...messages].reverse().find((m) => m.sender === 'cliente') || null;
  const lastAnswer = [...messages].reverse().find((m) => m.sender === 'vendedor') || null;
  const conversationStatus = messagesResp.conversation_status?.status || null;
  // OJO: el estado "mediación" depende de que la conversación esté "blocked" AHORA
  // MISMO, no de si logramos bajar el detalle del reclamo — Mercado Libre puede
  // reportar "blocked" sin mandar todavía el claim_id, y aun así la conversación
  // está genuinamente bloqueada por una mediación en curso.
  const isBlocked = conversationStatus === 'blocked';
  const mediation = isBlocked
    ? await resolveMediation(token, messagesResp.conversation_status?.claim_ids)
    : null;
  const status = isBlocked
    ? 'mediacion'
    : (lastAnswer && lastQuestion && new Date(lastAnswer.date) > new Date(lastQuestion.date)
      ? 'respondido'
      : 'pendiente');

  // Mientras la conversación está bloqueada por mediación ya bajamos el detalle
  // completo del reclamo (vía resolveMediation) — lo guardamos aparte para que, en
  // cuanto se resuelva y `mediation` vuelva a null, no haga falta gastar otra
  // llamada a la API (checkPastMediation) para recuperar lo mismo que ya sabíamos.
  const lastActiveMediation = isBlocked && mediation?.claimId
    ? { claimId: mediation.claimId, type: mediation.type || null, status: mediation.status, stage: mediation.stage, resolution: mediation.resolution }
    : (previousRecord?.lastActiveMediation || null);

  let pastMediation = previousRecord?.pastMediation || null;
  let pastMediationChecked = Boolean(previousRecord?.pastMediationChecked);
  if (isBlocked) {
    // Está mediando otra vez ahora mismo: en cuanto se resuelva hay que volver a
    // revisar (una sola vez, gratis, desde lastActiveMediation de abajo) — si no
    // reseteáramos esto, una venta que ya se había revisado sin reclamo previo se
    // quedaría para siempre sin mostrar esta mediación nueva una vez resuelta.
    pastMediationChecked = false;
  } else if (!pastMediationChecked && lastActiveMediation) {
    // Se acaba de resolver y ya tenemos el detalle completo de cuando estaba
    // bloqueada — nos ahorramos la llamada aparte de checkPastMediation.
    pastMediation = lastActiveMediation;
    pastMediationChecked = true;
  }

  // Si el reclamo/mediación de esta venta ya está CERRADO, el hilo normal de
  // mensajes puede quedarse "pendiente" para siempre aunque no haya nada que
  // contestar aquí — la resolución llegó por el reclamo (Mercado Libre aplicó un
  // reembolso, venció el plazo, etc.), no por una respuesta en este chat. Mostrarlo
  // como "pendiente" solo confundiría al equipo con un caso donde ya no se puede
  // hacer nada por esta vía (ver applyClosedClaimOverride, se reutiliza también en
  // checkPastMediation para cuando el reclamo cerrado se descubre después).
  const finalStatus = applyClosedClaimOverride(status, pastMediation);

  return {
    packId,
    orderId: info.orderId,
    orderUrl: info.orderId ? `https://www.mercadolibre.com.mx/ventas/${info.orderId}/detalle` : null,
    buyerName: info.buyerName,
    buyerId: info.buyerId,
    itemTitles: info.itemTitles,
    itemLinks: info.itemLinks || [],
    unreadCount,
    status: finalStatus,
    lastQuestion,
    lastAnswer,
    messages,
    orderCreationDate,
    conversationStatus,
    mediation,
    lastCheckedAt: new Date().toISOString(),
    lastActiveMediation,
    pastMediation,
    pastMediationChecked,
    pastMediationCheckAttempts: previousRecord?.pastMediationCheckAttempts || 0,
    // Se arrastra igual que el resto del historial de mediación: si no lo
    // conserváramos aquí, un pack "respondido" que se re-sincroniza por cualquier
    // otro motivo (aunque sea raro que eso pase) perdería su versión de backfill y
    // volvería a ser candidato sin necesidad.
    messagesBackfillVersion: previousRecord?.messagesBackfillVersion || 0,
  };
}

function syncPack(token, packEntry, cache) {
  const packId = packEntry.resource.match(/\/packs\/(\d+)\//)[1];
  return syncPackById(token, packId, cache, packEntry.count);
}

// Una vez que una mediación se resuelve, Mercado Libre deja de reportar la
// conversación como "blocked" — así que el estado "mediación" (arriba) desaparece
// solo, sin dejar rastro de que esa venta SÍ pasó por un reclamo. Esta función busca
// aparte, por order_id, cualquier reclamo ligado a la venta (abierto o cerrado) para
// no perder ese contexto. Solo se llama para packs que NUNCA la vimos bloqueada por
// mediación (si sí la vimos, syncPackById ya guarda el detalle en lastActiveMediation
// sin gastar esta llamada aparte — ver ahí).
async function checkPastMediation(token, record) {
  if (!record.orderId) {
    record.pastMediationChecked = true;
    return;
  }
  try {
    const resp = await fetchClaimsByOrder(token, record.orderId);
    // La forma exacta de la respuesta no está 100% documentada (results/data/array
    // plano) — cubrimos las variantes conocidas en vez de asumir una sola.
    const claims = Array.isArray(resp) ? resp : (resp?.results || resp?.data || []);
    if (claims.length) {
      // Nos quedamos con el más reciente (no el primero que venga, el orden no
      // está garantizado) y le pedimos el detalle completo por el mismo camino que
      // ya usamos para mediaciones activas, en vez de confiar en que el resumen
      // del buscador traiga los mismos campos que /claims/{id}.
      const [mostRecent] = claims
        .slice()
        .sort((a, b) => new Date(b.last_updated || b.date_created || 0) - new Date(a.last_updated || a.date_created || 0));
      try {
        const detail = await fetchClaimDetail(token, mostRecent.id);
        record.pastMediation = {
          claimId: mostRecent.id,
          type: detail.type || mostRecent.type || null,
          status: detail.status || mostRecent.status || null,
          stage: detail.stage || mostRecent.stage || null,
          resolution: detail.resolution || null,
        };
      } catch {
        // Si falla el detalle, al menos dejamos lo que ya sabíamos por la búsqueda.
        record.pastMediation = {
          claimId: mostRecent.id,
          type: mostRecent.type || null,
          status: mostRecent.status || null,
          stage: mostRecent.stage || null,
          resolution: null,
        };
      }
    }
    // Igual que en syncPackById: si esto descubre que el reclamo ya está cerrado y
    // el pack seguía "pendiente" en caché, ya no hay nada que contestar por el chat
    // normal — se reclasifica para no dejarlo inflando la cola de pendientes.
    record.status = applyClosedClaimOverride(record.status, record.pastMediation);
    record.pastMediationChecked = true;
    record.pastMediationCheckAttempts = 0;
  } catch (err) {
    console.warn('No se pudo revisar historial de reclamos del pack', record.packId, err.message);
    // No se marca "checked" en un error transitorio: se reintenta en un ciclo
    // futuro. Para no reintentar así para siempre si el problema es permanente
    // (p.ej. el endpoint cambió), nos rendimos después de unos intentos.
    record.pastMediationCheckAttempts = (record.pastMediationCheckAttempts || 0) + 1;
    if (record.pastMediationCheckAttempts >= 3) record.pastMediationChecked = true;
  }
}

// Cuántas conversaciones "viejas" (ya no reportadas como no leídas por ML) se
// revisan de nuevo en cada ciclo — ver comentario en runSyncInner().
const STALE_REFRESH_BATCH = 80;

// Cuántos packs se revisan por ciclo buscando mediaciones YA cerradas (ver
// checkPastMediation) — como cada pack solo se revisa una vez en su vida
// (pastMediationChecked), no hace falta que el lote sea tan grande como el de
// arriba: es un backlog que se agota, no algo que se repita para siempre.
const PAST_MEDIATION_CHECK_BATCH = 30;

// Igual de acotado y por el mismo motivo (backlog que se agota una sola vez, no
// algo que se repita) — ver comentario junto a messagesBackfillCandidates en
// runSyncInner().
// Subido de 40 a 80: con la versión 2 (PDFs) TODAS las "respondido" vuelven a ser
// candidatas de golpe (~600+), y a 40/ciclo tardaría casi una hora en cubrirlas todas.
const MESSAGES_BACKFILL_BATCH = 80;

// Cada vez que una corrección necesite releer el historial completo de las
// conversaciones "respondido" ya en caché (que si no, nunca se vuelven a
// sincronizar), se sube este número — eso hace que TODAS pasen una vez más por el
// backfill de abajo, sin importar que ya hubieran pasado por una versión anterior.
// V1: la paginación de mensajes que se perdía en silencio. V2: los PDFs adjuntos
// que se descartaban por completo antes de guardarse.
const MESSAGES_BACKFILL_VERSION = 2;

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
  // Se calcula una sola vez para todo el lote (no por cada pack) — son las mismas
  // respuestas frecuentes para cualquier borrador que se genere en este ciclo de sync.
  // Solo se cuentan las usadas 3+ veces, para filtrar casos raros o con errores de una
  // sola vez que alguien haya editado a mano.
  const frequentResponses = pendingToGenerate > 0
    ? computeResponseBank(await loadAnswerLog()).filter((r) => r.count >= 3).slice(0, 15)
    : [];
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
      const { text, imagesExcluded } = await generateDraftAnswer({
        buyerName: record.buyerName,
        itemTitles: record.itemTitles,
        messages: record.messages,
        orderCreationDate: record.orderCreationDate,
        token,
        frequentResponses,
      });
      record.draftAnswer = { text, generatedAt: new Date().toISOString(), forQuestionDate: questionDate, imagesExcluded };
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
  const unreadPackIds = new Set(
    unread.results.map((entry) => entry.resource.match(/\/packs\/(\d+)\//)[1]),
  );
  const results = await mapWithConcurrency(unread.results, 5, (entry) => syncPack(token, entry, cache));

  // Lo "no leído" de ML solo avisa de mensajes nuevos, pero una conversación
  // también cambia de estado cuando alguien la contesta o la lee directamente
  // en Mercado Libre (sin pasar por esta app) — y en ese caso deja de aparecer
  // en /messages/unread para siempre, así que nunca nos enteraríamos. Por eso,
  // además de lo recién marcado no leído, revisamos de nuevo un lote acotado de
  // lo que YA conocíamos y seguía "pendiente"/"mediación" la última vez. Se hace
  // en lotes (no las ~600 de golpe) para no saturar el rate limit de la API;
  // como el sync corre cada 2 minutos, en un rato quedan todas al día. Una vez
  // que una conversación llega a "respondido" deja de re-consultarse (ya no
  // puede desactualizarse sola: si el cliente vuelve a escribir, ML la vuelve a
  // reportar como no leída y entra por la rama de arriba).
  const staleCandidates = Object.entries(cache.packs)
    .filter(([packId, entry]) => entry.record?.status !== 'respondido' && !unreadPackIds.has(packId))
    .sort((a, b) => new Date(a[1].record?.lastCheckedAt || 0) - new Date(b[1].record?.lastCheckedAt || 0))
    .slice(0, STALE_REFRESH_BATCH)
    .map(([packId]) => packId);
  const staleResults = await mapWithConcurrency(
    staleCandidates,
    5,
    (packId) => syncPackById(token, packId, cache, 0),
  );

  // Arrancamos con todo lo que ya conocíamos: las conversaciones nunca se borran.
  // Solo se actualizan las que vienen frescas en este ciclo (no leídas + el lote
  // de refresco); el resto se queda tal cual estaba (y no se reescribe en Redis).
  const packs = { ...cache.packs };
  const touched = new Set();
  let errors = 0;
  [...results, ...staleResults].forEach((r) => {
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

  // Igual que el refresco de arriba, pero para el historial de mediaciones YA
  // cerradas (ver checkPastMediation) — nunca se re-consulta dos veces el mismo
  // pack, así que este lote solo cubre lo que todavía no se había revisado ni una
  // vez, y termina agotándose sin quedar dando vueltas para siempre.
  //
  // A propósito esto NO pasa por el `touched`/savePacksBulk de abajo: este lote
  // puede tocar packs "respondido" (que el resto del sync ya no vuelve a
  // sincronizar nunca) y con `packs` siendo una foto tomada al inicio del ciclo
  // (hasta 90s de por medio), un savePacksBulk con esa foto podría pisar una
  // respuesta recién publicada o un borrador recién editado por alguien del
  // equipo mientras corría este mismo ciclo. Por eso cada pack se guarda aparte,
  // leyendo su valor más fresco de Redis justo antes de escribir.
  const pastMediationCandidates = Object.values(packs)
    .filter((p) => p.record.status !== 'mediacion' && !p.record.pastMediationChecked)
    .slice(0, PAST_MEDIATION_CHECK_BATCH);
  await mapWithConcurrency(pastMediationCandidates, 3, async (entry) => {
    const packId = entry.record.packId;
    await checkPastMediation(token, entry.record);
    const fresh = await loadPackEntry(packId);
    if (!fresh) return;
    Object.assign(fresh.record, {
      pastMediation: entry.record.pastMediation,
      pastMediationChecked: entry.record.pastMediationChecked,
      pastMediationCheckAttempts: entry.record.pastMediationCheckAttempts,
    });
    await savePackEntry(packId, fresh);
  });

  // Las conversaciones "respondido" en caché nunca se vuelven a sincronizar solas
  // (el resto del sync las excluye a propósito) — pero a veces una corrección de
  // fondo (paginación de mensajes, adjuntos que se descartaban, etc.) necesita
  // releer el historial completo para que también aplique ahí. Este lote las
  // rellena UNA vez POR VERSIÓN (ver MESSAGES_BACKFILL_VERSION arriba): si ya
  // pasaron por la versión actual no se vuelven a tocar, pero si sube el número de
  // versión, todas vuelven a ser candidatas una vez más.
  const messagesBackfillCandidates = Object.values(packs)
    .filter((p) => p.record.status === 'respondido' && (p.record.messagesBackfillVersion || 0) < MESSAGES_BACKFILL_VERSION)
    .slice(0, MESSAGES_BACKFILL_BATCH);
  await mapWithConcurrency(messagesBackfillCandidates, 3, async (entry) => {
    const packId = entry.record.packId;
    try {
      const refreshed = await syncPackById(token, packId, cache, entry.record.unreadCount || 0);
      refreshed.messagesBackfillVersion = MESSAGES_BACKFILL_VERSION;
      const fresh = await loadPackEntry(packId);
      if (!fresh) return;
      // Solo pisamos si sigue "respondido": si en el rato que tomó esta llamada
      // alguien contestó de nuevo (nueva pregunta del cliente, otra mediación...),
      // preferimos dejar que el flujo normal de arriba lo resuelva en el próximo
      // ciclo en vez de arriesgarnos a pisar ese cambio con datos ya obsoletos.
      if (fresh.record.status === 'respondido') {
        fresh.record = refreshed;
        await savePackEntry(packId, fresh);
      }
    } catch (err) {
      console.warn('No se pudo rellenar el historial completo del pack', packId, err.message);
    }
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
  const frequentResponses = computeResponseBank(await loadAnswerLog()).filter((r) => r.count >= 3).slice(0, 15);
  const { text, imagesExcluded } = await generateDraftAnswer({
    buyerName: record.buyerName,
    itemTitles: record.itemTitles,
    messages: record.messages,
    orderCreationDate: record.orderCreationDate,
    token,
    frequentResponses,
  });
  record.draftAnswer = {
    text,
    generatedAt: new Date().toISOString(),
    forQuestionDate: record.lastQuestion?.date || null,
    imagesExcluded,
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

async function publishAnswerInner(packId, answeredBy, attachments) {
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
  // `attachments` viene de /api/messages/:packId/attachment (subido momentos antes
  // por el vendedor) — son filenames hasheados que ML ya tiene guardados, listos
  // para referenciarse aquí. Si viene vacío, se manda el mensaje sin adjuntos igual
  // que siempre.
  const attachmentFilenames = (attachments || []).map((a) => a.filename).filter(Boolean);
  await sendPackMessage(token, packId, SELLER_ID, record.buyerId, text, attachmentFilenames);

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
  const wasEdited = Boolean(record.draftAnswer?.edited);
  // Guarda igual que los adjuntos del cliente (mismo shape: filename/mimeType/
  // siteId/kind) para que se muestre con el mismo botón "Ver PDF"/miniatura en el
  // hilo. 'MLM' porque esta app solo maneja la cuenta de México.
  const localAttachments = (attachments || []).map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    siteId: 'MLM',
    kind: a.mimeType === 'application/pdf' ? 'pdf' : 'image',
  }));
  record.messages.push({ sender: 'vendedor', text, date: now, hasAttachment: localAttachments.length > 0, attachments: localAttachments });
  record.lastAnswer = { sender: 'vendedor', text, date: now, hasAttachment: localAttachments.length > 0 };
  record.status = 'respondido';
  record.draftAnswer = null;
  record.answeredBy = answeredBy || null;

  await savePackEntry(packId, entry);
  await appendAnswerLog({
    packId,
    buyerName: record.buyerName,
    itemTitles: record.itemTitles,
    answeredBy: answeredBy || null,
    wasEdited,
    text,
    question: record.lastQuestion?.text || null,
    date: now,
  });
  return record;
}

function publishAnswer(packId, answeredBy, attachments) {
  return withLock(`lock:pack:${packId}`, 30000, () => publishAnswerInner(packId, answeredBy, attachments));
}

const app = express();
app.use(cookieParser());
app.use(express.json());

// Rutas que deben quedar accesibles SIN sesión: la propia página de login, el
// endpoint que valida usuario/contraseña, y el cron externo (que se autentica con
// su propio CRON_SECRET, no con una sesión de usuario).
const PUBLIC_PATHS = new Set(['/login.html', '/api/auth/login', '/api/cron/sync']);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const email = verifySessionToken(req.cookies[SESSION_COOKIE]);
  if (!email) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/login.html');
  }
  req.userEmail = email;
  next();
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = await verifyCredentials(email, password);
    res.cookie(SESSION_COOKIE, createSessionToken(normalizedEmail), {
      httpOnly: true,
      // Vercel siempre sirve por https; en local (npm start) no hay https, así que la
      // cookie "secure" se desactiva ahí o el navegador la descartaría por completo.
      secure: Boolean(process.env.VERCEL),
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
});

app.get('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/login.html');
});

app.get('/api/auth/me', (req, res) => {
  res.json({ email: req.userEmail });
});

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
    const record = await publishAnswer(req.params.packId, req.userEmail, req.body?.attachments);
    res.json({ record });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Formatos y tamaño que Mercado Libre acepta para adjuntar a un mensaje de
// postventa (no es una limitación nuestra, es la que documenta la API).
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'text/plain']);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// A diferencia del resto de rutas (JSON), esta recibe el archivo tal cual en el
// body (bytes crudos) — el navegador lo manda como blob, sin envolverlo en
// multipart, así que del lado de esta app no hace falta ninguna librería para
// parsearlo. El multipart/form-data que sí exige la API de Mercado Libre se arma
// en uploadAttachment (lib/ml.js) al reenviarlo.
app.post(
  '/api/messages/:packId/attachment',
  express.raw({ type: '*/*', limit: MAX_ATTACHMENT_BYTES }),
  async (req, res) => {
    try {
      const mimeType = req.query.mimeType;
      const filename = req.query.filename;
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'No se recibió ningún archivo' });
      }
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({ error: 'Mercado Libre solo acepta PDF, JPG, PNG o TXT como adjunto' });
      }
      if (req.body.length > MAX_ATTACHMENT_BYTES) {
        return res.status(400).json({ error: 'El archivo supera el máximo de 25 MB que permite Mercado Libre' });
      }
      const { access_token: token } = await getAccessToken();
      const uploaded = await uploadAttachment(token, req.body, filename || 'adjunto', mimeType, 'MLM');
      res.json({ filename: uploaded.filename, originalFilename: filename || null, mimeType });
    } catch (err) {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

// Presencia en vivo: quién tiene abierta cada conversación ahora mismo. No necesita
// limpieza activa — un valor se considera "vigente" solo si su timestamp es reciente
// (PRESENCE_TTL_MS), así que una pestaña cerrada simplemente deja de aparecer sola.
const PRESENCE_KEY = 'app:presence';
const PRESENCE_TTL_MS = 15000;

app.post('/api/presence/:packId', async (req, res) => {
  await redis.hset(PRESENCE_KEY, { [req.params.packId]: { email: req.userEmail, ts: Date.now() } });
  res.status(204).end();
});

app.get('/api/log', async (req, res) => {
  const entries = await loadAnswerLog();
  res.json({ entries });
});

app.get('/api/response-bank', async (req, res) => {
  const entries = await loadAnswerLog();
  res.json({ bank: computeResponseBank(entries) });
});

app.get('/api/presence', async (req, res) => {
  const raw = await redis.hgetall(PRESENCE_KEY);
  const now = Date.now();
  const viewers = {};
  for (const [packId, value] of Object.entries(raw || {})) {
    const data = parseMaybeJson(value);
    if (data && now - data.ts < PRESENCE_TTL_MS && data.email !== req.userEmail) {
      viewers[packId] = data.email;
    }
  }
  res.json({ viewers });
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

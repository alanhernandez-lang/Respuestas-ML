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
  fetchAllSellerOrders,
  fetchShipmentDetail,
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
const {
  generateDraftAnswer,
  extractRefacturaData,
  extractEnvioAcordadoData,
  detectsFirstFacturaRequest,
  classifyAgreedShippingFirstContact,
  REFACTURA_FIELD_LABELS,
  ENVIO_ACORDADO_FIELD_LABELS,
} = require('./lib/agent');
const { redis, withLock } = require('./lib/redis');
const { legacyUpstashClient } = require('./lib/legacyUpstash');
const { SESSION_COOKIE, verifyCredentials, createSessionToken, verifySessionToken } = require('./lib/auth');

// 2026-08-29: reintroducido tras un ciclo real de caídas en producción — Upstash
// alcanzó su límite de solicitudes ("max requests limit exceeded") y cada llamada a
// Redis sin try/catch alrededor (login, sync, etc.) tronaba como promesa/excepción
// sin capturar, matando el proceso entero una y otra vez apenas Coolify lo volvía a
// levantar. Esto no arregla que Redis siga rechazando comandos (eso requiere subir
// el límite/plan de Upstash o esperar a que se reinicie), pero al menos deja el
// proceso vivo y respondiendo, en vez de reiniciarse sin parar.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Promesa rechazada sin capturar:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] Excepción sin capturar (proceso sigue vivo):', err);
});

const CLAIM_ROLE_LABELS = { mediator: 'Mediador (ML)', respondent: 'Vendedor (tú)', complainant: 'Cliente' };

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '');
}

// Traducción de lo que reporta el envío al mismo texto que ya se usa en el panel
// de vendedor de Mercado Libre — si llega un estatus que no está aquí, se muestra
// tal cual (en vez de ocultarlo) para no perder la información.
const SHIPPING_STATUS_LABELS = {
  pending: 'Pendiente',
  handling: 'En preparación',
  ready_to_ship: 'Listo para enviar',
  shipped: 'Enviado',
  delivered: 'Entregado',
  not_delivered: 'No entregado',
  cancelled: 'Cancelado',
};

// A diferencia del resto de resolvePackInfo (buyerId/itemLinks, que ya no cambian
// una vez conocidos), el estatus de envío SÍ avanza con el tiempo — un pedido
// "enviado" hoy puede ser "entregado" en unos días. `shippingSettled` marca cuándo
// ya no hace falta volver a preguntar: cuando llegó a un estado final (entregado/
// cancelado/no entregado) o cuando de plano no hay envío que dé seguimiento
// ("acordar con el vendedor"). Mientras no esté settled, resolvePackInfo lo vuelve
// a consultar en cada sync (barato: un GET a /shipments, sin volver a bajar cada
// ítem ni al comprador).
const TERMINAL_SHIPPING_STATUSES = new Set(['delivered', 'cancelled', 'not_delivered']);

// Cuando la venta se acuerda directo con el comprador (sin logística de Mercado
// Libre), `order.shipping` no trae `id` — ahí ni siquiera existe un envío que
// consultar, así que se reporta directo como "Acordar con el vendedor" en vez de
// gastar una llamada a /shipments que fallaría de todos modos.
async function resolveShippingInfo(token, order) {
  const shippingId = order.shipping?.id;
  if (!shippingId) {
    return { isFull: false, shippingStatus: null, shippingStatusLabel: 'Acordar con el vendedor', shippingSettled: true };
  }
  try {
    const shipment = await fetchShipmentDetail(token, shippingId);
    const status = shipment.status || null;
    return {
      isFull: shipment.logistic_type === 'fulfillment',
      shippingStatus: status,
      shippingStatusLabel: status ? (SHIPPING_STATUS_LABELS[status] || status) : null,
      shippingSettled: TERMINAL_SHIPPING_STATUSES.has(status),
    };
  } catch (err) {
    console.warn('No se pudo consultar el envío', shippingId, err.message);
    return { isFull: false, shippingStatus: null, shippingStatusLabel: null, shippingSettled: false };
  }
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

// Conteo acumulado de respuestas por persona/día — separado de ANSWER_LOG_KEY a
// propósito. Ese log se recorta a las últimas ANSWER_LOG_MAX (1000) para no crecer
// sin límite (piensa en el banco de respuestas, que solo necesita texto reciente),
// pero con el volumen actual del equipo esas 1000 entradas se llenan en menos de
// un día entre todas las personas — así que la gráfica de "respuestas por persona"
// y el contador junto a cada nombre en la Bitácora, que SÍ dependían de ese mismo
// log recortado, se quedaban "atorados": cada respuesta nueva de la persona más
// activa tira una entrada vieja SUYA para hacerle lugar, y el total no se mueve
// aunque siga contestando (caso real: Getzemany, 2026-09-01, "desde ayer tengo
// 804 y hoy ya conteste y no cambia nada"). Este hash nunca se recorta: una
// respuesta más solo hace HINCRBY, así que el contador siempre sube y el
// histórico completo por día queda disponible para "todo el historial".
const ANSWER_COUNTS_KEY = 'app:answercounts';

// Mismo criterio de "día" para todo mundo sin importar en qué huso horario corra
// el servidor: México ya no tiene horario de verano (desde 2022), así que
// America/Mexico_City es un offset fijo (UTC-6) — coincide con el día que ve en
// pantalla el equipo, que trabaja desde ahí. formato en-CA da directo YYYY-MM-DD.
const MEXICO_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function mexicoDayKey(dateIso) {
  return MEXICO_DAY_FORMATTER.format(new Date(dateIso));
}

async function bumpAnswerCount(email, dateIso) {
  if (!email) return; // el backfill histórico no sabe quién respondió — no hay nada que sumar
  await redis.hincrby(ANSWER_COUNTS_KEY, `${mexicoDayKey(dateIso)}|${email}`, 1);
}

async function loadAnswerCounts() {
  return (await redis.hgetall(ANSWER_COUNTS_KEY)) || {};
}

// Arranque en caliente, una sola vez: si ANSWER_COUNTS_KEY todavía no existe
// (primera vez que corre este código, o el hash se perdió en algún incidente de
// Redis como el de agosto), lo reconstruye a partir de lo que SÍ hay en
// app:answerlog. Eso solo cubre las últimas ANSWER_LOG_MAX respuestas —no es un
// historial completo—, pero evita que el contador arranque en 0 justo cuando
// alguien esté viendo la gráfica. Una vez poblado (por esto o por una respuesta
// real vía bumpAnswerCount), no se vuelve a tocar: el chequeo "¿ya tiene algo?"
// hace que llamarlo de nuevo en cada arranque sea inofensivo.
async function seedAnswerCountsIfEmpty() {
  try {
    await withLock('lock:answercounts:seed', 60000, async () => {
      const existing = await redis.hgetall(ANSWER_COUNTS_KEY);
      if (existing && Object.keys(existing).length > 0) return;
      const entries = await loadAnswerLog();
      let seeded = 0;
      for (const e of entries) {
        if (!e.answeredBy || !e.date) continue;
        await redis.hincrby(ANSWER_COUNTS_KEY, `${mexicoDayKey(e.date)}|${e.answeredBy}`, 1);
        seeded++;
      }
      console.log(`[answercounts] sembrado inicial: ${seeded} respuestas recuperadas de app:answerlog`);
    });
  } catch (err) {
    if (err.status !== 409) console.error('[answercounts] error sembrando contador inicial:', err.message);
  }
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
  // buyerId/itemLinks (con sus permalinks) ya no cambian una vez conocidos — pero
  // el estatus de envío sí avanza con el tiempo (ver TERMINAL_SHIPPING_STATUSES), así
  // que "está completo" y "el envío ya no necesita refrescarse" son dos cosas
  // distintas: solo cuando las DOS son ciertas nos ahorramos ir a preguntarle a ML.
  const hasCoreInfo = Boolean(cached && cached.buyerId && cached.itemLinks);
  const shippingDone = Boolean(cached?.shippingChecked && cached?.shippingSettled);
  if (hasCoreInfo && shippingDone) return cached;

  // Cuando una orden no forma parte de un pack real de Mercado Libre, la API de
  // mensajes usa el order_id como si fuera pack_id y /packs/{id} responde 404.
  // En ese caso tratamos el id como order_id directamente. Si ya conocíamos el
  // orderId (solo nos falta refrescar el envío), nos ahorramos volver a preguntar.
  let orderId = cached?.orderId;
  if (!orderId) {
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
  }

  if (!orderId) {
    return {
      orderId: null,
      buyerName: cached?.buyerName || 'Cliente desconocido',
      itemTitles: cached?.itemTitles || [],
      itemLinks: cached?.itemLinks || [],
      buyerId: cached?.buyerId || null,
      saleDate: cached?.saleDate || null,
      shippingChecked: true,
      isFull: false,
      shippingStatus: null,
      shippingStatusLabel: null,
      shippingSettled: true,
    };
  }

  const order = await fetchOrderDetail(token, orderId);
  const shippingInfo = await resolveShippingInfo(token, order);

  if (hasCoreInfo) {
    // Ya teníamos lo caro (comprador, títulos, permalinks de cada ítem) — solo se
    // actualiza lo que sí puede haber cambiado (envío), sin volver a bajar cada
    // ítem ni pedir el detalle del comprador de nuevo.
    return { ...cached, saleDate: order.date_created || cached.saleDate, shippingChecked: true, ...shippingInfo };
  }

  // Primera vez que se ve este pack: hay que bajar todo desde cero.
  const buyerName = buyerDisplayName(order.buyer);
  const itemTitles = (order.order_items || []).map((oi) => oi.item?.title).filter(Boolean);
  const buyerId = order.buyer?.id || null;

  // El permalink real (con su slug de SEO) solo viene en el recurso completo del
  // ítem, no en el resumen embebido dentro de la orden — por eso se consulta aparte.
  const itemIds = (order.order_items || []).map((oi) => oi.item?.id).filter(Boolean);
  const itemLinks = (await Promise.all(itemIds.map(async (itemId) => {
    try {
      const item = await fetchItemDetail(token, itemId);
      return { title: item.title, url: item.permalink };
    } catch {
      return null;
    }
  }))).filter(Boolean);

  return {
    orderId,
    buyerName,
    itemTitles,
    itemLinks,
    buyerId,
    saleDate: order.date_created || null,
    shippingChecked: true,
    ...shippingInfo,
  };
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
  // 2026-08-31: "blocked" sin claim_id resultó NO ser confiable como señal de
  // mediación genuina — se probó primero un margen de antigüedad (asumiendo que solo
  // lo viejo-sin-reclamo era una ventana cerrada por tiempo), pero en producción esto
  // seguía marcando cientos de conversaciones recientes-pero-sin-reclamo como
  // mediación (378 de 722, verificado en vivo). Confirmado con /post-purchase/v1/claims
  // directo: sin claimId, casi nunca hay un reclamo real detrás, sin importar la
  // antigüedad.
  //
  // Ni siquiera tener claimId bastó: comparado contra el panel real de Mercado
  // Libre (43 reclamos y mediaciones activos), la app mostraba 344 — 314 de esos
  // 344 ya tenían mediation.status "closed" (reclamo YA resuelto, la conversación
  // seguía marcada "blocked" por el lado de ML aunque el reclamo en sí ya cerró).
  // Se exige además que el reclamo siga "opened" — no basta con que exista.
  const isGenuineMediation = isBlocked && Boolean(mediation?.claimId) && mediation?.status === 'opened';
  // Antes de las automatizaciones de "primer contacto" (envío acordado, 2026-09-21),
  // toda conversación arrancaba siempre con un mensaje del CLIENTE — así que
  // lastQuestion nunca era null una vez que había algo de actividad, y exigir
  // lastAnswer && lastQuestion nunca era un problema. Ahora el VENDEDOR puede ser
  // quien escribe primero (el cliente todavía no ha contestado nada), y en ese caso
  // lastQuestion sigue siendo null para siempre — la condición de abajo nunca se
  // cumplía y la conversación se quedaba en "pendiente" aunque ya no hubiera nada
  // que el equipo tuviera que hacer (caso real: Jose Carlos Topete Gonzalez,
  // 2026-09-24, solo tenía el mensaje automático del vendedor y ningún mensaje del
  // cliente, y aun así aparecía como pendiente). Si ya hay una respuesta nuestra y
  // el cliente nunca ha preguntado nada, no hay nada pendiente de nuestro lado —
  // cuenta como "respondido" (estamos esperando al cliente, no al revés).
  const naturalStatus = isGenuineMediation
    ? 'mediacion'
    : (!lastAnswer
      ? 'pendiente'
      : (!lastQuestion || new Date(lastAnswer.date) > new Date(lastQuestion.date) ? 'respondido' : 'pendiente'));
  // 2026-08-31: si ML bloqueó la conversación pero todavía no calificó como
  // mediación genuina arriba (sin claimId confirmado, típicamente un reclamo
  // recién abierto cuyo ID aún no propaga), tampoco debe verse como "pendiente"
  // normal — publicar una respuesta por el chat no sirve de nada mientras siga
  // bloqueada, y confunde al equipo mostrando un botón "Publicar" que va a fallar.
  // Caso real: pedido de Laura Iveth Herrera Parra, bloqueado sin número de caso
  // todavía, se veía como "pendiente" con un borrador listo para publicar.
  const status = (naturalStatus === 'pendiente' && isBlocked && !isGenuineMediation)
    ? 'respondido'
    : naturalStatus;

  // Mientras la conversación está bloqueada por mediación ya bajamos el detalle
  // completo del reclamo (vía resolveMediation) — lo guardamos aparte para que, en
  // cuanto se resuelva y `mediation` vuelva a null, no haga falta gastar otra
  // llamada a la API (checkPastMediation) para recuperar lo mismo que ya sabíamos.
  const lastActiveMediation = isBlocked && mediation?.claimId
    ? { claimId: mediation.claimId, type: mediation.type || null, status: mediation.status, stage: mediation.stage, resolution: mediation.resolution }
    : (previousRecord?.lastActiveMediation || null);

  let pastMediation = previousRecord?.pastMediation || null;
  let pastMediationChecked = Boolean(previousRecord?.pastMediationChecked);
  if (isGenuineMediation) {
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
    saleDate: info.saleDate,
    isFull: info.isFull,
    shippingStatus: info.shippingStatus,
    shippingStatusLabel: info.shippingStatusLabel,
    shippingSettled: info.shippingSettled,
    // Para el filtro de "Refacturas" del sidebar (ver categoryCountsHtml en app.js).
    // El de "Envíos acordados" no necesita un campo aparte: reutiliza
    // shippingStatusLabel === 'Acordar con el vendedor', que ya viene de la API de
    // envíos de ML (dato exacto), a diferencia de esto que solo es una detección por
    // texto (ver REFACTURA_ASK_PATTERNS/clientMentionedFactura/vendorSentFacturaPdf,
    // definidos más abajo en este archivo pero disponibles aquí igual — son
    // const/función de módulo, ya están asignados para cuando esta función se llama
    // de verdad). Cuenta como candidata si el VENDEDOR ya pidió los datos fiscales
    // O si el CLIENTE mencionó factura/CFDI en cualquiera de sus mensajes — antes
    // solo miraba lo primero, así que un cliente que pide/manda su factura antes de
    // que nadie del equipo le conteste (caso real: "Xa Za", 2026-09-24, mandó toda
    // su factura en su primer mensaje) no aparecía en el filtro aunque claramente
    // necesitaba atención de refactura. En ambos casos se exige además que el
    // vendedor NO le haya entregado ya el PDF de la factura — así una conversación
    // ya cerrada no reaparece en el filtro solo porque el cliente volvió a escribir
    // por otro tema.
    isRefacturaCandidate: (vendorAskedFor(messages, REFACTURA_ASK_PATTERNS) || clientMentionedFactura(messages))
      && !vendorSentFacturaPdf(messages),
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

// 2026-08-31: checkPastMediation (arriba) solo corre UNA vez en la vida de cada
// pack — sirve para rellenar el historial, no para vigilar reclamos nuevos. Hueco
// real encontrado: una vez que un pack llega a "respondido", el sync normal deja de
// tocarlo (solo se re-revisa si el cliente escribe un mensaje nuevo); si el cliente
// abre un reclamo/mediación DIRECTO en Mercado Libre sin escribir nada en el chat,
// la app nunca se entera. Confirmado en vivo: el panel real de ML mostraba 44
// reclamos y mediaciones activos, la app solo 24 — los que faltaban eran justo
// estos, reclamos abiertos sobre packs ya "respondido" que nunca se volvieron a
// revisar. Esta función sí se repite periódicamente (ver lastMediationWatchAt).
async function checkNewMediation(token, record) {
  if (!record.orderId) {
    record.lastMediationWatchAt = new Date().toISOString();
    return;
  }
  try {
    const resp = await fetchClaimsByOrder(token, record.orderId);
    const claims = Array.isArray(resp) ? resp : (resp?.results || resp?.data || []);
    const [mostRecent] = claims
      .slice()
      .sort((a, b) => new Date(b.last_updated || b.date_created || 0) - new Date(a.last_updated || a.date_created || 0));
    if (mostRecent && mostRecent.status === 'opened') {
      // Mismo criterio que en syncPackById: solo cuenta como mediación real si el
      // detalle completo confirma que sigue abierto — el resumen del buscador a
      // veces no coincide con /claims/{id}.
      try {
        const detail = await fetchClaimDetail(token, mostRecent.id);
        if (detail.status === 'opened') {
          record.mediation = {
            claimId: mostRecent.id,
            type: detail.type || mostRecent.type || null,
            status: detail.status,
            stage: detail.stage || mostRecent.stage || null,
            resolution: detail.resolution || null,
          };
          record.lastActiveMediation = { ...record.mediation };
          record.status = 'mediacion';
        }
      } catch (err) {
        console.warn('No se pudo confirmar el detalle del reclamo nuevo del pack', record.packId, err.message);
      }
    }
  } catch (err) {
    console.warn('No se pudo revisar reclamo nuevo del pack', record.packId, err.message);
  }
  record.lastMediationWatchAt = new Date().toISOString();
}

// Cuántos packs "respondido" se revisan por ciclo buscando un reclamo nuevo (ver
// checkNewMediation) — a diferencia de PAST_MEDIATION_CHECK_BATCH (un backlog que se
// agota una sola vez), este lote se repite para siempre: cualquier venta ya
// respondida puede escalar a un reclamo en cualquier momento. Con ~1000+
// "respondido" y 50 por ciclo (cada 2 min), toda la cartera queda revisada cada
// ~40 minutos.
const MEDIATION_WATCH_BATCH = 50;

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
// que se descartaban por completo antes de guardarse. V3: isRefacturaCandidate
// (filtro de categoría del sidebar) — sin este bump, todo lo ya cacheado como
// "respondido" se quedaría sin ese campo hasta que alguien vuelva a escribir.
const MESSAGES_BACKFILL_VERSION = 3;

// El borrador de IA sigue siendo válido mientras nadie haya hecho una pregunta
// nueva desde que se generó, así que solo se regenera cuando cambia lastQuestion.
// `touched` acumula los packIds que de verdad cambiaron este ciclo, para que
// runSync() solo reescriba esos en Redis (no los ~170 completos cada vez).
async function attachDrafts(packs, token, touched) {
  const pendingEntries = Object.values(packs).filter((p) => p.record.status === 'pendiente');
  if (!pendingEntries.length) return;

  // Se calcula una sola vez para todo el lote (no por cada pack) — son las mismas
  // respuestas frecuentes para cualquier borrador que se genere en este ciclo de sync.
  // Solo se cuentan las usadas 3+ veces, para filtrar casos raros o con errores de una
  // sola vez que alguien haya editado a mano.
  const frequentResponses = computeResponseBank(await loadAnswerLog()).filter((r) => r.count >= 3).slice(0, 15);
  let fresh = 0;
  let ok = 0;
  let failed = 0;
  // OJO: este mapWithConcurrency debe correr SIEMPRE para TODOS los pendientes, incluso
  // cuando nadie necesita un borrador nuevo — es el único lugar donde se copia el
  // draftAnswer ya generado hacia el objeto `record` fresco de este ciclo. Si se salta,
  // el borrador se "pierde" (queda undefined) aunque nunca haya dejado de ser válido.
  await mapWithConcurrency(pendingEntries, 3, async (entry) => {
    const record = entry.record;
    const questionDate = record.lastQuestion?.date || null;
    // Se lee el valor MÁS FRESCO de Redis (no una foto tomada al inicio del ciclo) —
    // un sync completo puede tardar bastante procesando cientos de packs, y si
    // alguien le daba "Regenerar" o editaba el borrador a mano justo en esa ventana,
    // comparar contra la foto vieja terminaba pisando ese cambio reciente con el
    // valor de antes, como si el botón "no hubiera hecho nada".
    const currentEntry = await loadPackEntry(record.packId);
    const previousDraft = currentEntry?.record?.draftAnswer;
    const isFresh = previousDraft && !previousDraft.error && previousDraft.forQuestionDate === questionDate;
    if (isFresh) {
      record.draftAnswer = previousDraft;
      fresh++;
      return;
    }
    try {
      const { text, imagesExcluded, flags } = await generateDraftAnswer({
        buyerName: record.buyerName,
        itemTitles: record.itemTitles,
        messages: record.messages,
        orderCreationDate: record.orderCreationDate,
        token,
        frequentResponses,
        isFull: record.isFull,
        shippingStatusLabel: record.shippingStatusLabel,
      });
      record.draftAnswer = { text, generatedAt: new Date().toISOString(), forQuestionDate: questionDate, imagesExcluded, flags };
      if (flags && flags.length) {
        console.warn(`Borrador IA del pack ${record.packId} marcado para revisar (${flags.join(', ')})`);
      }
      ok++;
    } catch (err) {
      console.warn('Error generando borrador IA para pack', record.packId, err.message);
      record.draftAnswer = { error: err.message, forQuestionDate: questionDate };
      failed++;
    }
    touched.add(record.packId);
  });
  if (ok > 0 || failed > 0) console.log(`Borradores IA: ${ok} generados, ${failed} con error, ${fresh} ya estaban al día.`);
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
    packs[r.packId] = {
      info: {
        orderId: r.orderId,
        buyerName: r.buyerName,
        buyerId: r.buyerId,
        itemTitles: r.itemTitles,
        itemLinks: r.itemLinks,
        saleDate: r.saleDate,
        isFull: r.isFull,
        shippingStatus: r.shippingStatus,
        shippingStatusLabel: r.shippingStatusLabel,
        shippingSettled: r.shippingSettled,
        shippingChecked: true,
      },
      record: r,
    };
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

  // Ver comentario junto a checkNewMediation/MEDIATION_WATCH_BATCH arriba: a
  // diferencia del lote de arriba (una sola vez en la vida del pack), este se repite
  // para siempre — ordenado por el que lleva más tiempo sin revisarse, para que con
  // el tiempo toda la cartera de "respondido" quede cubierta por igual.
  const mediationWatchCandidates = Object.values(packs)
    .filter((p) => p.record.status === 'respondido')
    .sort((a, b) => new Date(a.record.lastMediationWatchAt || 0) - new Date(b.record.lastMediationWatchAt || 0))
    .slice(0, MEDIATION_WATCH_BATCH);
  await mapWithConcurrency(mediationWatchCandidates, 3, async (entry) => {
    const packId = entry.record.packId;
    await checkNewMediation(token, entry.record);
    const fresh = await loadPackEntry(packId);
    if (!fresh) return;
    // Si mientras tanto alguien le contestó de nuevo (o dejó de estar "respondido"
    // por cualquier otra razón), no le pisamos ese cambio más reciente con esto.
    if (fresh.record.status !== 'respondido') return;
    Object.assign(fresh.record, {
      mediation: entry.record.mediation,
      lastActiveMediation: entry.record.lastActiveMediation,
      status: entry.record.status,
      lastMediationWatchAt: entry.record.lastMediationWatchAt,
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

  await attachDrafts(packs, token, touched);

  if (touched.size) {
    const toWrite = {};
    touched.forEach((id) => { toWrite[id] = packs[id]; });
    await savePacksBulk(toWrite);
  }
  const syncedAt = new Date().toISOString();
  await saveMeta({ syncedAt });

  // Corre DESPUÉS de que todo lo de arriba ya se guardó (savePacksBulk) — lee su
  // propia copia fresca de Redis en vez de reusar `packs`/`touched` de este ciclo,
  // para no arriesgarse a que el guardado en bloque de arriba pise con datos viejos
  // lo que esto vaya escribiendo (envía mensajes de verdad, no puede permitirse esa
  // condición de carrera). Ver comentario junto a su definición.
  await sendAutomationReminders().catch((err) => console.error('[automation] error inesperado mandando recordatorios:', err.message));
  // Misma razón que el de arriba: descubre y guarda packs nuevos por su cuenta
  // (ventas sin ningún mensaje todavía), así que corre aparte del resto del ciclo.
  await sendFirstContactForAgreedShipping().catch((err) => console.error('[automation] error inesperado mandando primer contacto:', err.message));
  // Independiente de sendAutomationReminders() a propósito (ver comentario junto a
  // su definición) — se apaga con su propia variable de entorno.
  await sendFacturaFirstContact().catch((err) => console.error('[automation] error inesperado mandando primer contacto de factura:', err.message));

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
  const previousText = record.draftAnswer?.text || null;
  const { access_token: token } = await getAccessToken();
  const frequentResponses = computeResponseBank(await loadAnswerLog()).filter((r) => r.count >= 3).slice(0, 15);
  const { text, imagesExcluded, flags } = await generateDraftAnswer({
    buyerName: record.buyerName,
    itemTitles: record.itemTitles,
    messages: record.messages,
    orderCreationDate: record.orderCreationDate,
    token,
    frequentResponses,
    previousDraftText: previousText,
    isFull: record.isFull,
    shippingStatusLabel: record.shippingStatusLabel,
  });
  if (flags && flags.length) {
    console.warn(`Borrador IA del pack ${packId} marcado para revisar (${flags.join(', ')})`);
  }
  record.draftAnswer = {
    text,
    generatedAt: new Date().toISOString(),
    forQuestionDate: record.lastQuestion?.date || null,
    imagesExcluded,
    flags,
    // Si el texto salió idéntico al anterior, casi siempre es porque la respuesta
    // correcta es una plantilla aprobada tal cual (factura, cabezal, etc.) — no un
    // error. El frontend usa esto para avisarlo en vez de dejar que se sienta como
    // que "Regenerar no hizo nada".
    unchanged: Boolean(previousText && previousText === text),
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
  await bumpAnswerCount(answeredBy, now);
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
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/api/auth/login',
  '/api/cron/sync',
  '/api/cron/backfill-history',
  '/api/cron/regenerate-pending-drafts',
  '/api/cron/backfill-automation-answer-counts',
  // Automatización n8n de refacturas/envíos acordados (ver
  // docs/odoo-refacturas-envios-automation-plan.md) — se autentica con CRON_SECRET,
  // mismo patrón que el cron externo, no con una sesión de usuario.
  '/api/automation/refacturas-pendientes',
  '/api/automation/envios-acordados-pendientes',
  '/api/automation/marcar-planificado',
]);

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

// Botón "🔄 Regenerar pendientes" del header — misma acción que
// /api/cron/regenerate-pending-drafts, pero con sesión de usuario en vez de
// CRON_SECRET: así cualquiera del equipo ya logueado la puede disparar desde la
// propia app, sin necesitar terminal ni conocer ningún secreto (2026-09-03, a
// petición de Alan después de no poder correr el curl con el secreto a mano).
app.post('/api/admin/regenerate-pending-drafts', async (req, res) => {
  res.json({ started: true }); // puede tardar varios minutos con muchos pendientes — se revisa en logs
  runRegeneratePendingDraftsInner().catch((err) => console.error('[regen-pendientes] Error general:', err));
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
      // OJO: el campo que devuelve ML para el archivo ya subido se llama "id" (ej.
      // "210438685_59f0f034....pdf"), NO "filename" — con el nombre equivocado esto
      // fallaba en silencio: la subida "funcionaba" (sin error visible, con la
      // tarjetita del archivo mostrándose normal), pero el identificador llegaba
      // undefined y al publicar el adjunto se descartaba solo, sin avisar a nadie.
      if (!uploaded.id) {
        throw new Error('Mercado Libre no devolvió un identificador para el archivo subido');
      }
      res.json({ filename: uploaded.id, originalFilename: filename || null, mimeType });
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

// Contador acumulado por persona/día (ver ANSWER_COUNTS_KEY) — a diferencia de
// /api/log, esto nunca pierde historial, así que es lo que alimenta la gráfica
// de "respuestas por persona" y el total junto a cada nombre en la Bitácora.
app.get('/api/answer-counts', async (req, res) => {
  const counts = await loadAnswerCounts();
  res.json({ counts });
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

// 2026-08-29: backfill de una sola vez — cuando Redis se quedó sin cupo y hubo que
// empezar con una base nueva y vacía, el sync normal (fetchUnreadPacks) solo trae de
// vuelta lo que Mercado Libre reporta como "no leído", así que las conversaciones ya
// respondidas (~1189 en el momento del incidente) se quedan fuera del caché para
// siempre a menos que se traigan aparte. Esta ruta recorre TODAS las ventas del
// vendedor (no solo lo pendiente) y reconstruye tanto el caché de packs como, para
// las ya respondidas, entradas de Bitácora — con `answeredBy`/`wasEdited` en null
// porque eso nunca lo guardó Mercado Libre, solo nuestra app.
async function runHistoryBackfillInner() {
  const { access_token: token } = await getAccessToken();
  const orders = await fetchAllSellerOrders(token, SELLER_ID);
  const packIds = [...new Set(orders.map((o) => o.pack_id || o.id))];
  console.log(`[backfill] ${orders.length} órdenes, ${packIds.length} packs únicos a revisar`);

  const cache = await loadCache();
  let done = 0;
  let errors = 0;
  let logged = 0;
  await mapWithConcurrency(packIds, 5, async (packId) => {
    try {
      const record = await syncPackById(token, packId, cache, 0);
      await savePackEntry(packId, {
        info: {
          orderId: record.orderId,
          buyerName: record.buyerName,
          buyerId: record.buyerId,
          itemTitles: record.itemTitles,
          itemLinks: record.itemLinks,
          saleDate: record.saleDate,
          isFull: record.isFull,
          shippingStatus: record.shippingStatus,
          shippingStatusLabel: record.shippingStatusLabel,
          shippingSettled: record.shippingSettled,
          shippingChecked: true,
        },
        record,
      });

      if (record.status === 'respondido') {
        const msgs = record.messages || [];
        for (let i = 0; i < msgs.length - 1; i++) {
          if (msgs[i].sender === 'cliente' && msgs[i + 1].sender === 'vendedor') {
            await appendAnswerLog({
              packId,
              buyerName: record.buyerName,
              itemTitles: record.itemTitles,
              answeredBy: null,
              wasEdited: false,
              text: msgs[i + 1].text,
              question: msgs[i].text,
              date: msgs[i + 1].date,
            });
            logged++;
          }
        }
      }
      done++;
      if (done % 50 === 0) console.log(`[backfill] progreso: ${done}/${packIds.length}`);
    } catch (err) {
      errors++;
      console.warn('[backfill] error en pack', packId, err.message);
    }
  });
  console.log(`[backfill] TERMINADO: ${done} ok, ${errors} con error, ${logged} entradas de bitácora reconstruidas`);
}

function runHistoryBackfill() {
  return withLock('lock:backfill:history', 3600000, runHistoryBackfillInner);
}

app.get('/api/cron/backfill-history', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  // No se espera a que termine (puede tardar bastante con cientos/miles de packs) —
  // se dispara en segundo plano y se revisa el avance en los logs.
  res.json({ started: true });
  runHistoryBackfill().catch((err) => console.error('[backfill] Error general:', err));
});

// 2026-09-01: uso puntual — al mejorar el prompt del agente de IA (mejor comprensión
// de la conversación completa, razonamiento activado en Flash), los borradores YA
// generados se quedan con el texto de la versión anterior: el sync normal los trata
// como "frescos" (mismo forQuestionDate, sin error) y nunca los vuelve a tocar, así
// que sin esto solo las conversaciones NUEVAS verían la mejora. Esta ruta fuerza un
// regenerateDraftInner (que sí ignora el estado "fresco") sobre cada pack pendiente
// actual, para que el equipo vea el borrador mejorado de inmediato en vez de esperar
// a que cada cliente vuelva a escribir.
async function runRegeneratePendingDraftsInner() {
  const cache = await loadCache();
  const pending = Object.values(cache.packs)
    .map((p) => p.record)
    .filter((r) => r.status === 'pendiente');
  console.log(`[regen-pendientes] ${pending.length} borradores pendientes a regenerar`);
  let ok = 0;
  let failed = 0;
  await mapWithConcurrency(pending, 3, async (record) => {
    try {
      await regenerateDraftInner(record.packId);
      ok++;
    } catch (err) {
      failed++;
      console.warn('[regen-pendientes] error en pack', record.packId, err.message);
    }
  });
  console.log(`[regen-pendientes] TERMINADO: ${ok} ok, ${failed} con error`);
}

app.get('/api/cron/regenerate-pending-drafts', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  res.json({ started: true }); // puede tardar varios minutos con muchos pendientes — se revisa en logs
  runRegeneratePendingDraftsInner().catch((err) => console.error('[regen-pendientes] Error general:', err));
});

// 2026-09-22: uso puntual, una sola vez — sendAutomatedMessage() ya suma al
// contador (bumpAnswerCount, ver comentario junto a su definición), pero eso solo
// corrige los mensajes automáticos mandados DESPUÉS de ese fix. Los que ya se
// habían mandado antes se quedaron en "app:answerlog" (la Bitácora) sin su
// contraparte en "app:answercounts" — por eso el chip de cada automatización se
// veía siempre en "(0)" aunque ya hubiera entradas reales en la lista. Este
// endpoint recorre el log y le suma a bumpAnswerCount lo que falte, UNA VEZ (el
// marcador en Redis evita que un segundo llamado accidental vuelva a contar lo
// mismo dos veces).
const AUTOMATION_ANSWERCOUNTS_BACKFILL_KEY = 'app:automation:answercounts_backfilled_v1';

async function backfillAutomationAnswerCountsInner() {
  const already = await redis.get(AUTOMATION_ANSWERCOUNTS_BACKFILL_KEY);
  if (already) return { skipped: true, backfilledAt: already };

  const entries = await loadAnswerLog();
  let counted = 0;
  for (const e of entries) {
    if (!e.answeredBy || !e.date) continue;
    if (!e.answeredBy.startsWith('Automatización')) continue; // solo lo que mandaron las automatizaciones, nunca a una persona real
    await bumpAnswerCount(e.answeredBy, e.date);
    counted++;
  }
  const backfilledAt = new Date().toISOString();
  await redis.set(AUTOMATION_ANSWERCOUNTS_BACKFILL_KEY, backfilledAt);
  return { skipped: false, counted, backfilledAt };
}

app.get('/api/cron/backfill-automation-answer-counts', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const result = await backfillAutomationAnswerCountsInner();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// Automatización n8n: refacturas y envíos acordados con el comprador (aprobado por
// el gerente de Alan con alcance reducido — ver
// docs/odoo-refacturas-envios-automation-plan.md, sección 3). n8n hace polling de
// estos endpoints, crea la "planificación" en Odoo (una Actividad sobre la
// cotización, para no depender de nombres de campo personalizados que todavía no
// están confirmados con quien administra Odoo), y avisa de vuelta con
// /marcar-planificado para que el mismo pack no se vuelva a ofrecer en la próxima
// corrida. Las validaciones humanas de Crédito y Cobranza / Tráfico NO se tocan —
// esto solo reemplaza el paso mecánico de capturar los datos en Odoo.
//
// AUTOMATION_PLANNED_KEY vive en Redis (no en el propio record del pack) para que
// "ya se mandó a Odoo" sobreviva a un re-sync normal del pack sin más lógica.
const AUTOMATION_PLANNED_KEY = 'app:automation:planned';

async function isAlreadyPlanned(categoria, packId) {
  return Boolean(await redis.hget(AUTOMATION_PLANNED_KEY, `${categoria}:${packId}`));
}

async function markPlanned(categoria, packId, extra) {
  await redis.hset(AUTOMATION_PLANNED_KEY, {
    [`${categoria}:${packId}`]: { plannedAt: new Date().toISOString(), ...extra },
  });
}

// Prefiltro barato antes de gastar una llamada a Gemini por pack: sin esto, cada
// corrida de n8n tendría que analizar los ~1500 packs del caché en vez de solo los
// que de verdad tienen una plantilla de este tipo de por medio. Se basa en el texto
// de las plantillas ya aprobadas (ver RESPONSE_TEMPLATES en lib/agent.js) — si esas
// plantillas cambian de redacción, hay que revisar estos patrones también.
const REFACTURA_ASK_PATTERNS = [/uso de cfdi/i, /r[eé]gimen fiscal/i, /raz[oó]n social/i];
const ENVIO_ACORDADO_ASK_PATTERNS = [/env[ií]o gratis/i, /dirección completa \(calle/i];

// A pedido de Alan (2026-09-22, ajustado el mismo día tras ver un caso real): una
// vez que el vendedor YA le entregó el PDF de la factura al cliente, esa
// conversación debe dejar de contar como "refactura pendiente" aunque el cliente
// vuelva a escribir después por otro tema — sin esto, isRefacturaCandidate se queda
// en true para siempre (nunca se "des-pide" un dato una vez pedido) y una
// conversación ya resuelta reaparecía en el filtro de refacturas solo porque el
// hilo volvió a estar "pendiente" por una pregunta sin relación.
//
// A propósito NO basta con el texto solo (p.ej. "Procedemos con la facturación de
// su compra", plantilla "Pasar a facturar") — ese mensaje es solo un aviso de que
// está en trámite (tarda 1-3 días hábiles), el PDF real normalmente llega después
// en un mensaje aparte, y hasta que eso pase sigue siendo trabajo pendiente de
// verdad. Por eso se exige texto de entrega (ver plantilla aprobada "Compartir
// factura ya generada" en RESPONSE_TEMPLATES, lib/agent.js) Y un PDF adjunto en ESE
// MISMO mensaje — así "te envío tu factura" sin nada adjunto (un despiste, o
// alguien escribiéndolo de más) no cierra el tema por accidente. Si el equipo cierra
// el tema con una redacción muy distinta a estos patrones, esto no lo detecta
// (mismo límite que cualquier prefiltro por texto, ver comentario de arriba).
const REFACTURA_CLOSE_TEXT_PATTERNS = [
  /te env(í|i)o (tu|su) factura/i,
  /te enviamos (tu|su) factura/i,
  /adjunto (tu|su) factura/i,
  /aqu(í|i) (tu|su|est(á|a)) factura/i,
  /factura (ya )?(enviada|generada|lista)/i,
];

function vendorAskedFor(messages, patterns) {
  return (messages || []).some((m) => m.sender === 'vendedor' && patterns.some((p) => p.test(m.text || '')));
}

function vendorSentFacturaPdf(messages) {
  return (messages || []).some((m) => m.sender === 'vendedor'
    && REFACTURA_CLOSE_TEXT_PATTERNS.some((p) => p.test(m.text || ''))
    && (m.attachments || []).some((a) => a.kind === 'pdf'));
}

// A pedido de Alan (2026-09-24, caso real: cliente "Xa Za" mandó su factura completa
// en su primer mensaje y la conversación no aparecía en el filtro de refacturas
// porque isRefacturaCandidate solo miraba si el VENDEDOR ya había pedido los datos
// — si el cliente se adelanta y pide/manda su factura antes de que nadie del equipo
// responda, antes no había ninguna señal que lo detectara). Prefiltro barato por
// texto (no Gemini) a propósito: esto solo alimenta un filtro/chip de la interfaz
// para que el equipo lo vea, no dispara ningún mensaje automático — el costo de un
// falso positivo aquí es mínimo (aparece de más en la lista), así que no amerita el
// costo/latencia de una llamada a Gemini por cada pack en cada sync, a diferencia de
// detectsFirstFacturaRequest (que sí decide si se manda un mensaje solo).
const CLIENT_FACTURA_MENTION_PATTERN = /factur|cfdi/i;

function clientMentionedFactura(messages) {
  return (messages || []).some((m) => m.sender === 'cliente' && CLIENT_FACTURA_MENTION_PATTERN.test(m.text || ''));
}

// ---------------------------------------------------------------------------------
// Recordatorio automático de datos faltantes (refactura / envío acordado) — decisión
// explícita de Alan (2026-09-10): a diferencia de la planificación en Odoo (que es
// interna, nadie del lado del cliente la ve), ESTO SÍ le manda un mensaje directo al
// cliente en Mercado Libre sin que nadie del equipo lo revise antes. Se acepta ese
// riesgo porque el texto es 100% mecánico — una plantilla ya aprobada (o la lista
// exacta de campos que faltan, tomada tal cual la escribió el cliente) — nunca texto
// libre inventado por la IA. La única parte que usa IA es decidir QUÉ falta, no QUÉ
// decir; si esa detección se equivoca, el peor caso es un recordatorio de más pidiendo
// un dato que el cliente ya había dado.
//
// Se dispara desde el propio ciclo de sync (cada 2 minutos), no desde n8n: no
// necesita Odoo para nada, así que no tiene sentido esperar al poll de n8n (cada 10
// minutos) para algo que la app ya puede resolver por su cuenta.
const AUTOMATION_REMINDED_KEY = 'app:automation:reminded';

// Solo manda el recordatorio una vez por cada mensaje nuevo del cliente (mismo
// criterio de "frescura" que ya usa el borrador de IA vía forQuestionDate) — si el
// cliente vuelve a escribir (aunque siga incompleto), sí se le manda un recordatorio
// actualizado; mientras no escriba de nuevo, no se le insiste con el mismo mensaje.
async function alreadyRemindedForQuestion(categoria, packId, questionDate) {
  const stored = await redis.hget(AUTOMATION_REMINDED_KEY, `${categoria}:${packId}`);
  return Boolean(stored) && stored.questionDate === questionDate;
}

async function markReminded(categoria, packId, questionDate) {
  await redis.hset(AUTOMATION_REMINDED_KEY, {
    [`${categoria}:${packId}`]: { questionDate, remindedAt: new Date().toISOString() },
  });
}

function buildRefacturaReminderText(missing) {
  const bullets = missing.map((key) => `• ${REFACTURA_FIELD_LABELS[key]}`).join('\n');
  return `Gracias por la información. Para poder emitir su factura aún nos falta que nos comparta:\n${bullets}\n\nEn cuanto recibamos los datos completos, procedemos con la emisión.`;
}

// Copia literal de la plantilla aprobada "Solicitar datos de factura" (ver
// RESPONSE_TEMPLATES en lib/agent.js) — mismo criterio que ENVIO_ACORDADO_FIRST_CONTACT_TEXT
// de abajo: se reutiliza tal cual en vez de referenciarla dinámicamente.
const FACTURA_FIRST_CONTACT_TEXT = 'Buen día 🙏 Con gusto realizamos su factura. Para generarla, favor de enviarnos:\n• Constancia de situación fiscal (PDF o fotografía legible)\n• Uso de CFDI\n• Forma de pago\n\nEn cuanto recibamos la información completa, procedemos con su emisión.';

// Copia literal de la plantilla aprobada "Solicitud de datos para envío gratis" (ver
// RESPONSE_TEMPLATES en lib/agent.js) — se reutiliza tal cual en vez de
// referenciarla dinámicamente, para no depender de que el prompt del agente de IA
// nunca cambie esa plantilla sin querer.
const ENVIO_ACORDADO_FIRST_CONTACT_TEXT = 'Hola, buen día. Tu pedido aplica para envío gratis 🎉 Para activarlo necesito que me envíes por mensaje los siguientes datos completos:\n• Nombre:\n• Dirección completa (calle, número, colonia, CP, ciudad y estado)\n• Referencias de domicilio\n• Teléfono\n\nEn cuanto los reciba, libero tu envío sin costo. Quedo pendiente.';

// Mismo mecanismo de envío que publishAnswerInner (buyerId al vuelo si falta,
// mandar, marcar leído, reflejar en el caché y en la bitácora), pero sin depender de
// que exista un draftAnswer. SÍ suma al mismo contador que usa publishAnswerInner
// (bumpAnswerCount, con el label de la automatización en vez de un email) — sin
// esto, la automatización aparecía como chip de filtro en la Bitácora (porque
// appendAnswerLog sí la registra) pero siempre con "(0)", porque ese número sale de
// answerCounts, no de contar entradas del feed (ver comentario junto a renderLog en
// public/app.js).
async function sendAutomatedMessage(packId, text, label) {
  const entry = await getPackEntryOrThrow(packId);
  const record = entry.record;
  const { access_token: token } = await getAccessToken();

  if (!record.buyerId && record.orderId) {
    try {
      const order = await fetchOrderDetail(token, record.orderId);
      record.buyerId = order.buyer?.id || null;
      if (entry.info) entry.info.buyerId = record.buyerId;
    } catch {
      // sigue sin buyerId, cae al error de abajo
    }
  }
  if (!record.buyerId) {
    throw new Error('No se pudo identificar al comprador de esta conversación');
  }

  await sendPackMessage(token, packId, SELLER_ID, record.buyerId, text, []);
  try {
    await markPackMessagesRead(token, packId, SELLER_ID);
  } catch (err) {
    console.warn('No se pudo marcar como leído el pack', packId, err.message);
  }

  const now = new Date().toISOString();
  record.messages.push({ sender: 'vendedor', text, date: now, hasAttachment: false, attachments: [] });
  record.lastAnswer = { sender: 'vendedor', text, date: now, hasAttachment: false };
  record.status = 'respondido';
  record.draftAnswer = null;
  record.answeredBy = label;
  await savePackEntry(packId, entry);
  await appendAnswerLog({
    packId,
    buyerName: record.buyerName,
    itemTitles: record.itemTitles,
    answeredBy: label,
    wasEdited: false,
    text,
    question: record.lastQuestion?.text || null,
    date: now,
  });
  await bumpAnswerCount(label, now);
}

async function remindOneCategory(record, { categoria, askPatterns, fieldLabels, extractFn, buildText, label }) {
  if (!vendorAskedFor(record.messages, askPatterns)) return;
  if (await isAlreadyPlanned(categoria, record.packId)) return; // ya completo y planificado — nada que recordar
  const questionDate = record.lastQuestion?.date || null;
  if (!questionDate || (await alreadyRemindedForQuestion(categoria, record.packId, questionDate))) return;

  const { complete, missing } = await extractFn(record.messages, process.env.GEMINI_API_KEY);
  const totalFields = Object.keys(fieldLabels).length;
  // Ni completo (no hay nada que recordar) ni en cero (el cliente todavía no
  // contestó nada — insistir antes de que responda algo sería puro spam):
  // recordamos solo el caso de en medio, datos parciales.
  if (complete || missing.length === 0 || missing.length >= totalFields) return;

  try {
    await withLock(`lock:pack:${record.packId}`, 30000, () => sendAutomatedMessage(record.packId, buildText(missing), label));
    await markReminded(categoria, record.packId, questionDate);
  } catch (err) {
    console.warn(`[automation] no se pudo mandar recordatorio (${categoria}) del pack`, record.packId, err.message);
  }
}

// ---------------------------------------------------------------------------------
// Primer contacto automático cuando el cliente pide factura/refactura por primera
// vez (a pedido de Alan, 2026-09-22, mismo criterio de aprobación que el primer
// contacto de envío acordado): a diferencia de ese caso (donde el disparador es un
// dato exacto de la API, `shipping.id` ausente), aquí el disparador es la intención
// del CLIENTE en su propio mensaje — no hay forma de saberlo sin interpretar texto
// libre, así que se apoya en detectsFirstFacturaRequest (lib/agent.js, vía Gemini)
// en vez de un regex simple, para no dispararse con negaciones ("no necesito
// factura") ni con un cliente que ya la había pedido antes en el mismo hilo.
//
// No hace falta descubrir packs nuevos por su cuenta (a diferencia del envío
// acordado): el cliente pidiendo factura ya llega por el sync normal como
// "pendiente", así que esto corre dentro del mismo lote de candidatos de
// sendAutomationReminders(), no por separado.
const AUTOMATION_FACTURA_FIRST_CONTACT_KEY = 'app:automation:first_contact_factura';

async function isFacturaFirstContactHandled(packId) {
  return Boolean(await redis.hget(AUTOMATION_FACTURA_FIRST_CONTACT_KEY, packId));
}

async function markFacturaFirstContactHandled(packId, questionDate) {
  await redis.hset(AUTOMATION_FACTURA_FIRST_CONTACT_KEY, {
    [packId]: { questionDate, handledAt: new Date().toISOString() },
  });
}

async function sendFacturaFirstContactForRecord(record) {
  if (process.env.AUTOMATION_FACTURA_FIRST_CONTACT_ENABLED !== 'true') return;
  // Caso real (2026-09-24, casos de Jose Manuel Trejo Medellin y Laura Marcela Ruiz
  // Leos): en pedidos "Acordar con el vendedor" es muy común que el cliente pida su
  // factura Y necesite coordinar el envío en el mismo mensaje o mensajes seguidos —
  // el borrador de IA revisado por un humano ya combina bien los dos temas en una
  // sola respuesta (ver REGLA GENERAL sobre MÁS DE UN TEMA PENDIENTE en el prompt de
  // lib/agent.js), pero esta automatización solo manda la plantilla de factura sola,
  // sin tocar el envío — mandarla aquí dejaría el tema de envío sin resolver y sin
  // que nadie se entere. Por eso, en estos pedidos, nunca se manda automático: se
  // deja pasar siempre a revisión humana.
  if (record.shippingStatusLabel === 'Acordar con el vendedor') return;
  if (!CLIENT_FACTURA_MENTION_PATTERN.test(record.lastQuestion?.text || '')) return;
  // A pedido explícito de Alan (2026-09-24): esta plantilla SOLO es para el mensaje
  // simple ("me pueden facturar", "necesito facturar"), nunca cuando el cliente ya
  // mandó algún dato (aunque sea uno) o adjuntó una foto/PDF — eso se deja siempre
  // como borrador para que alguien lo revise a mano, la plantilla genérica volvería
  // a pedir datos que ya dio. Chequeo determinístico aparte del que hace Gemini más
  // abajo (detectsFirstFacturaRequest) porque un adjunto sin texto no siempre se lo
  // describe bien a la IA, y esto es más barato/confiable que depender solo de ella.
  if (record.lastQuestion?.hasAttachment) return;
  // El vendedor ya pidió estos datos antes en este hilo (misma señal que usa el
  // recordatorio de refactura de abajo) — entonces esta ya no es la primera vez.
  if (vendorAskedFor(record.messages, REFACTURA_ASK_PATTERNS)) return;
  if (await isFacturaFirstContactHandled(record.packId)) return;
  const questionDate = record.lastQuestion?.date || null;
  if (!questionDate) return;

  let asksForFactura;
  try {
    asksForFactura = await detectsFirstFacturaRequest(record.messages, process.env.GEMINI_API_KEY);
  } catch (err) {
    console.warn('[automation] no se pudo evaluar solicitud de factura del pack', record.packId, err.message);
    return;
  }
  if (!asksForFactura) return;

  try {
    await withLock(`lock:pack:${record.packId}`, 30000, () => sendAutomatedMessage(record.packId, FACTURA_FIRST_CONTACT_TEXT, 'Automatización (primer contacto — solicitud de factura)'));
    await markFacturaFirstContactHandled(record.packId, questionDate);
  } catch (err) {
    console.warn('[automation] no se pudo mandar el primer contacto (factura) del pack', record.packId, err.message);
  }
}

// Wrapper con su propia carga de caché, a propósito SEPARADO de
// sendAutomationReminders() de abajo — aunque ambos recorren los mismos candidatos
// "pendiente", cada uno tiene que apagarse con su propia variable de entorno sin
// depender de la otra (AUTOMATION_FACTURA_FIRST_CONTACT_ENABLED aquí,
// AUTOMATION_REMINDERS_ENABLED allá). El chequeo de la variable también vive dentro
// de sendFacturaFirstContactForRecord — aquí se repite antes para no gastar un
// loadCache() completo cuando está apagada.
async function sendFacturaFirstContact() {
  if (process.env.AUTOMATION_FACTURA_FIRST_CONTACT_ENABLED !== 'true') return;
  const cache = await loadCache();
  const candidates = Object.values(cache.packs)
    .map((p) => p.record)
    .filter((r) => r && r.status === 'pendiente');
  await mapWithConcurrency(candidates, 3, (record) => sendFacturaFirstContactForRecord(record));
}

// Apagado por default a propósito: esto manda mensajes reales al cliente en
// Mercado Libre SIN revisión humana (ver comentario de AUTOMATION_REMINDED_KEY
// arriba). No hay forma de confirmar desde el código si Coolify ya desplegó un
// commit dado, así que en vez de asumir que "recién subido" significa "todavía no
// corre en producción", que el propio deploy quede inofensivo hasta que alguien
// prenda AUTOMATION_REMINDERS_ENABLED=true a propósito en las variables de entorno.
async function sendAutomationReminders() {
  if (process.env.AUTOMATION_REMINDERS_ENABLED !== 'true') return;
  const cache = await loadCache();
  const candidates = Object.values(cache.packs)
    .map((p) => p.record)
    .filter((r) => r && r.status === 'pendiente');

  // OJO: a pedido explícito de Alan (2026-09-21), "envío acordado" ya NO manda un
  // recordatorio automático si el cliente contesta incompleto — en pedidos "Acordar
  // con el vendedor" lo único que se manda sin revisión humana es el primer contacto
  // (ver sendFirstContactForAgreedShipping). Cualquier respuesta del cliente después
  // de eso (completa, incompleta, o cualquier otra cosa) pasa por el borrador de IA
  // normal en la pestaña "Borradores IA", igual que el resto de casos. Solo queda el
  // recordatorio automático de "refactura" (sin relación con envíos).
  await mapWithConcurrency(candidates, 3, async (record) => {
    await remindOneCategory(record, {
      categoria: 'refactura',
      askPatterns: REFACTURA_ASK_PATTERNS,
      fieldLabels: REFACTURA_FIELD_LABELS,
      extractFn: extractRefacturaData,
      buildText: buildRefacturaReminderText,
      label: 'Automatización (datos de refactura faltantes)',
    });
  });
}

// ---------------------------------------------------------------------------------
// Primer contacto automático en pedidos "Acordar con el vendedor" (a pedido de Alan,
// 2026-09-21, con visto bueno de su gerente): a diferencia del recordatorio de
// arriba (que solo insiste sobre un pendiente que YA se le planteó al cliente),
// esto manda el PRIMER mensaje del hilo completo, sin esperar a que el cliente
// escriba nada — apenas se detecta la venta. El sync normal (fetchUnreadPacks) jamás
// la encontraría por su cuenta: sin ningún mensaje todavía, Mercado Libre no la
// reporta como "no leída". Por eso se descubre aparte, consultando ventas recientes
// por /orders/search (mismo endpoint que runHistoryBackfillInner, pero acotado a los
// últimos días en vez de todo el historial) y filtrando las que no tengan
// `shipping.id` (mismo criterio exacto que resolveShippingInfo usa para reportar
// "Acordar con el vendedor"). Ese filtro sobre el resultado de /orders/search es solo
// un prefiltro barato para no llamar syncPackById de más: la decisión real de
// mandar el mensaje se apoya en record.shippingStatusLabel, que sí viene del mismo
// resolveShippingInfo ya confiable en el resto de la app.
//
// Igual que el recordatorio de arriba, el texto es 100% mecánico (la plantilla
// aprobada tal cual, nunca texto libre de la IA) y queda apagado por default hasta
// que alguien prenda AUTOMATION_FIRST_CONTACT_ENABLED=true a propósito.
const AUTOMATION_FIRST_CONTACT_KEY = 'app:automation:first_contact_envio_acordado';
// Ventana chica a propósito: solo hace falta alcanzar a las ventas de hoy/ayer antes
// de que alguien las note manualmente — no es un backfill histórico.
const FIRST_CONTACT_ORDERS_DAYS_BACK = 2;

async function isFirstContactHandled(packId) {
  return Boolean(await redis.hget(AUTOMATION_FIRST_CONTACT_KEY, packId));
}

async function markFirstContactHandled(packId, extra) {
  await redis.hset(AUTOMATION_FIRST_CONTACT_KEY, {
    [packId]: { handledAt: new Date().toISOString(), ...extra },
  });
}

async function sendFirstContactForAgreedShipping() {
  if (process.env.AUTOMATION_FIRST_CONTACT_ENABLED !== 'true') return;

  const { access_token: token } = await getAccessToken();
  const cache = await loadCache();
  const orders = await fetchAllSellerOrders(token, SELLER_ID, FIRST_CONTACT_ORDERS_DAYS_BACK);
  // El descubrimiento por /orders/search (últimos 2 días) es lo que sostiene esta
  // automatización en marcha normal — pero se combina con TODO lo que ya está en
  // caché como "Acordar con el vendedor" y pendiente, sin importar la fecha de la
  // orden (a pedido de Alan, 2026-09-24: barrer también los pendientes de antes de
  // que existiera esta automatización, o que por lo que sea la ventana de 2 días se
  // haya saltado). isFirstContactHandled sigue evitando que un pack ya evaluado se
  // vuelva a procesar en ciclos futuros, así que este barrido extra solo tiene
  // efecto real la primera vez que corre sobre cada pack.
  const knownAgreedShippingPending = Object.values(cache.packs)
    .filter((p) => p.record?.status === 'pendiente' && p.record?.shippingStatusLabel === 'Acordar con el vendedor')
    .map((p) => p.record.packId);
  const packIds = [...new Set([
    ...orders.filter((o) => !o.shipping?.id && o.status !== 'cancelled').map((o) => o.pack_id || o.id),
    ...knownAgreedShippingPending,
  ])];

  let sentEnvio = 0;
  let sentAmbas = 0;
  let skipped = 0;
  await mapWithConcurrency(packIds, 3, async (packId) => {
    if (await isFirstContactHandled(packId)) return;
    try {
      const record = await syncPackById(token, packId, cache, 0);
      if (record.shippingStatusLabel !== 'Acordar con el vendedor') {
        skipped++;
        await markFirstContactHandled(packId);
        return;
      }
      // El vendedor ya le contestó algo a este pack (a mano, o por otra vía) — el
      // flujo normal ya se encarga, mandar esto encima sería un mensaje duplicado.
      if (record.messages.some((m) => m.sender === 'vendedor')) {
        skipped++;
        await markFirstContactHandled(packId);
        return;
      }

      // A pedido explícito de Alan (2026-09-24, "opción 2" del problema de la
      // carrera con el sync): ya no exige que el hilo esté completamente vacío —
      // si el cliente escribió primero (antes de que esta automatización alcanzara
      // a mandar su mensaje), igual se manda la plantilla de envío, SIEMPRE Y
      // CUANDO lo que escribió no obligue a ignorar algo importante. Un chequeo
      // determinístico barato (adjuntos) más classifyAgreedShippingFirstContact
      // (Gemini, lib/agent.js) deciden si es seguro mandar algo automático o si hay
      // que abstenerse y dejarlo pasar a revisión humana.
      let category = 'solo_envio';
      if (record.messages.length > 0) {
        const clientAttached = record.messages.some((m) => m.sender === 'cliente' && m.hasAttachment);
        if (clientAttached) {
          category = 'abstenerse';
        } else {
          try {
            category = await classifyAgreedShippingFirstContact(record.messages, process.env.GEMINI_API_KEY);
          } catch (err) {
            console.warn('[automation] no se pudo clasificar el primer mensaje del pack', packId, err.message);
            category = 'abstenerse';
          }
        }
      }

      if (category === 'abstenerse') {
        skipped++;
        await markFirstContactHandled(packId);
        return;
      }

      await savePackEntry(packId, {
        info: {
          orderId: record.orderId,
          buyerName: record.buyerName,
          buyerId: record.buyerId,
          itemTitles: record.itemTitles,
          itemLinks: record.itemLinks,
          saleDate: record.saleDate,
          isFull: record.isFull,
          shippingStatus: record.shippingStatus,
          shippingStatusLabel: record.shippingStatusLabel,
          shippingSettled: record.shippingSettled,
          shippingChecked: true,
        },
        record,
      });
      await withLock(`lock:pack:${packId}`, 30000, async () => {
        await sendAutomatedMessage(packId, ENVIO_ACORDADO_FIRST_CONTACT_TEXT, 'Automatización (primer contacto — envío acordado)');
        // Caso real (2026-09-24): el cliente ya pidió factura en el mismo mensaje
        // donde apenas se está enterando del envío gratis, sin haber dado ningún
        // dato todavía — se manda también la plantilla de factura, en un segundo
        // mensaje aparte, en vez de dejarla pasar a revisión humana sin necesidad.
        if (category === 'envio_y_factura') {
          await sendAutomatedMessage(packId, FACTURA_FIRST_CONTACT_TEXT, 'Automatización (primer contacto — solicitud de factura)');
        }
      });
      if (category === 'envio_y_factura') sentAmbas++; else sentEnvio++;
      await markFirstContactHandled(packId);
    } catch (err) {
      console.warn('[automation] no se pudo mandar el primer contacto (envío acordado) del pack', packId, err.message);
    }
  });
  if (sentEnvio > 0 || sentAmbas > 0 || skipped > 0) {
    console.log(`[automation] Primer contacto envío acordado: ${sentEnvio} solo envío, ${sentAmbas} envío+factura, ${skipped} sin mandar.`);
  }
}

function checkAutomationSecret(req, res) {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'No autorizado' });
    return false;
  }
  return true;
}

async function findPendingForCategory({ categoria, askPatterns, extractFn }) {
  const cache = await loadCache();
  const candidates = Object.values(cache.packs)
    .map((p) => p.record)
    .filter((r) => r && vendorAskedFor(r.messages, askPatterns));

  const results = [];
  await mapWithConcurrency(candidates, 3, async (record) => {
    if (await isAlreadyPlanned(categoria, record.packId)) return;
    const { complete, data } = await extractFn(record.messages, process.env.GEMINI_API_KEY);
    if (!complete) return;
    results.push({
      packId: record.packId,
      orderId: record.orderId,
      buyerName: record.buyerName,
      itemTitles: record.itemTitles,
      datos: data,
    });
  });
  return results;
}

app.get('/api/automation/refacturas-pendientes', async (req, res) => {
  if (!checkAutomationSecret(req, res)) return;
  try {
    const pendientes = await findPendingForCategory({
      categoria: 'refactura',
      askPatterns: REFACTURA_ASK_PATTERNS,
      extractFn: extractRefacturaData,
    });
    res.json({ pendientes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/automation/envios-acordados-pendientes', async (req, res) => {
  if (!checkAutomationSecret(req, res)) return;
  try {
    const pendientes = await findPendingForCategory({
      categoria: 'envio_acordado',
      askPatterns: ENVIO_ACORDADO_ASK_PATTERNS,
      extractFn: extractEnvioAcordadoData,
    });
    res.json({ pendientes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/automation/marcar-planificado', async (req, res) => {
  if (!checkAutomationSecret(req, res)) return;
  try {
    const { packId, categoria, odooActivityId } = req.body || {};
    if (!packId || !categoria) {
      return res.status(400).json({ error: 'Falta packId o categoria' });
    }
    await markPlanned(categoria, packId, odooActivityId ? { odooActivityId } : undefined);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2026-09-04: migración única de Upstash al Redis de Coolify (ver lib/redis.js,
// lib/legacyUpstash.js y REDIS_URL) — Upstash llegó al 90% de su cupo gratuito de
// comandos/mes en solo 3 días. Se dispara sola al arrancar, protegida por lock +
// un chequeo de "¿ya hay datos?" (si app:users ya tiene algo en el Redis nuevo,
// asumimos que ya se migró y no se toca nada) — así que correr esto de más nunca
// duplica ni pisa datos ya migrados. Nunca lanza el error hacia afuera: si algo
// falla, el servidor arranca de todos modos (mejor arrancar con lo que haya que no
// arrancar en absoluto), pero avisa fuerte en los logs para revisarlo a mano.
async function migrateFromUpstashIfEmpty() {
  try {
    await withLock('lock:migrate:upstash-to-coolify', 300000, async () => {
      const existingUsers = await redis.hgetall('app:users');
      if (existingUsers && Object.keys(existingUsers).length > 0) {
        console.log('[migrate] el Redis de Coolify ya tiene datos — se omite la migración de Upstash');
        return;
      }
      const legacy = legacyUpstashClient();
      if (!legacy) {
        console.warn('[migrate] no hay credenciales de Upstash (KV_REST_API_URL/TOKEN) — se omite la migración');
        return;
      }
      console.log('[migrate] iniciando migración de Upstash al Redis de Coolify...');

      // Claves de un solo valor — se copian tal cual (@upstash/redis ya las
      // deserializa igual que nuestro wrapper nuevo, ver lib/redis.js encode()).
      for (const key of ['ml:token', 'ml:cache:meta', 'app:lastSyncError']) {
        const value = await legacy.get(key);
        if (value != null) await redis.set(key, value);
      }

      // Hashes chicos: HGETALL directo no arriesga el límite de tamaño de request
      // de Upstash (a diferencia de ml:cache:packs, mucho más grande — ver abajo).
      // app:users es el más crítico de los tres: sin él nadie puede iniciar sesión.
      for (const key of ['app:users', 'app:answercounts']) {
        const value = await legacy.hgetall(key);
        if (value && Object.keys(value).length) await redis.hset(key, value);
      }

      // app:answerlog es una lista — se lee completa (tope ya acotado a 1000) y se
      // vuelve a insertar con RPUSH en el mismo orden de lectura, para conservar el
      // orden original (se escribió con LPUSH: el índice 0 ya es "más nuevo primero").
      const logEntries = await legacy.lrange('app:answerlog', 0, -1);
      for (const entry of logEntries) await redis.rpush('app:answerlog', entry);

      // ml:cache:packs puede ser grande — se lee con HSCAN en lotes chicos (mismo
      // motivo que los scripts de corrección de datos de esta temporada: un HGETALL
      // de golpe ya nos hizo violar el límite de tamaño de request de Upstash antes).
      let cursor = '0';
      let migratedPacks = 0;
      do {
        const [nextCursor, raw] = await legacy.hscan('ml:cache:packs', cursor, { count: 50 });
        cursor = nextCursor;
        // El SDK de Upstash devuelve los pares como array plano [campo, valor, ...]
        // (igual que la respuesta nativa de Redis) — se agrupan en un objeto.
        const chunk = {};
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i += 2) chunk[raw[i]] = raw[i + 1];
        } else if (raw) {
          Object.assign(chunk, raw);
        }
        if (Object.keys(chunk).length) {
          await redis.hset('ml:cache:packs', chunk);
          migratedPacks += Object.keys(chunk).length;
        }
      } while (cursor !== '0');

      console.log(`[migrate] TERMINADO: ${migratedPacks} packs, ${logEntries.length} entradas de bitácora, usuarios y contadores copiados`);
    });
  } catch (err) {
    if (err.status !== 409) console.error('[migrate] error inesperado migrando de Upstash:', err.message);
  }
}

// Se espera a que la migración termine ANTES de aceptar tráfico (app.listen): sin
// esto, alguien podría intentar iniciar sesión o el sync podría correr contra un
// Redis nuevo todavía vacío justo en la ventana entre el arranque y que termine de
// copiarse todo.
async function startServer() {
  await migrateFromUpstashIfEmpty();
  seedAnswerCountsIfEmpty().catch((err) => console.error('[answercounts] error inesperado sembrando:', err.message));

  const port = process.env.PORT || 3000;
  // En Vercel el módulo se importa como función serverless (@vercel/node), sin
  // llamar a listen(); localmente (npm start) sí necesitamos el servidor real.
  if (require.main === module) {
    app.listen(port, () => {
      console.log(`Mensajes ML disponibles en http://localhost:${port}`);
    });
  }
}

startServer().catch((err) => console.error('Error fatal al arrancar el servidor:', err));

module.exports = app;

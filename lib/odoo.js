// Cliente de Odoo para la planificación automática de refacturas (ver
// docs/odoo-refacturas-envios-automation-plan.md). Usa JSON-RPC (mismo servicio que
// XML-RPC, mismos métodos `common.authenticate`/`object.execute_kw`) en vez de una
// librería de XML-RPC: Odoo expone el mismo API por JSON-RPC en /jsonrpc, y así se
// evita agregar una dependencia nueva solo para esto — ya se probó contra Odoo 18
// Enterprise (tanto el snapshot de prueba tod18.marvelsa.com como producción real
// marvelsa.com) y responde igual que XML-RPC.
//
// Validado a mano antes de automatizar (2026-09/10): búsqueda de la cotización por
// `meli_order_id` (NO por `name` — confirmado con un caso real, pedido
// 2000015405558146, que el `name` "ML <otro número>" puede no coincidir con el
// pedido real de Mercado Libre), subida de adjuntos (PDF o foto) vía `ir.attachment`
// + `message_post` (para que se vea como mensaje del chatter con autor/fecha, no
// como adjunto suelto — confirmado con Alan: "andale asi mero"), y creación de la
// Actividad "Refactura ME" con los datos fiscales en la nota.

let cachedUid = null;
let cachedSaleOrderModelId = null;
let rpcIdCounter = 1;

function requireConfig() {
  const url = process.env.ODOO_URL;
  const db = process.env.ODOO_DB;
  const login = process.env.ODOO_LOGIN;
  const apiKey = process.env.ODOO_API_KEY;
  if (!url || !db || !login || !apiKey) {
    throw new Error('Falta configurar ODOO_URL/ODOO_DB/ODOO_LOGIN/ODOO_API_KEY en .env');
  }
  return { url, db, login, apiKey };
}

async function rpcCall(service, method, args) {
  const { url } = requireConfig();
  const res = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: rpcIdCounter++,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Odoo JSON-RPC respondió ${res.status}`);
  const body = await res.json();
  if (body.error) {
    const message = body.error.data?.message || body.error.message || 'Error desconocido de Odoo';
    throw new Error(`Odoo: ${message}`);
  }
  return body.result;
}

async function authenticate() {
  const { db, login, apiKey } = requireConfig();
  const uid = await rpcCall('common', 'authenticate', [db, login, apiKey, {}]);
  if (!uid) throw new Error('Odoo rechazó la autenticación (ODOO_LOGIN/ODOO_API_KEY inválidos, de otro ambiente, o la key expiró)');
  return uid;
}

async function getUid() {
  if (!cachedUid) cachedUid = await authenticate();
  return cachedUid;
}

// Si la uid cacheada quedó inválida (key rotada/expirada a medio vuelo), reintenta
// una sola vez re-autenticando en vez de fallar directo.
async function executeKw(model, method, args, kwargs = {}) {
  const { db, apiKey } = requireConfig();
  const uid = await getUid();
  try {
    return await rpcCall('object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
  } catch (err) {
    cachedUid = null;
    const freshUid = await getUid();
    return rpcCall('object', 'execute_kw', [db, freshUid, apiKey, model, method, args, kwargs]);
  }
}

async function getSaleOrderModelId() {
  if (cachedSaleOrderModelId) return cachedSaleOrderModelId;
  const rows = await executeKw('ir.model', 'search_read', [[['model', '=', 'sale.order']]], { fields: ['id'], limit: 1 });
  if (!rows.length) throw new Error('No se encontró el modelo sale.order en Odoo');
  cachedSaleOrderModelId = rows[0].id;
  return cachedSaleOrderModelId;
}

async function findSaleOrderByMeliOrderId(meliOrderId) {
  const rows = await executeKw('sale.order', 'search_read', [[['meli_order_id', '=', String(meliOrderId)]]], {
    fields: ['id', 'name'],
    limit: 1,
  });
  return rows[0] || null;
}

async function createAttachment({ orderId, filename, base64, mimeType }) {
  return executeKw('ir.attachment', 'create', [{
    name: filename,
    datas: base64,
    res_model: 'sale.order',
    res_id: orderId,
    mimetype: mimeType,
  }]);
}

async function postChatterMessage(orderId, body, attachmentIds) {
  return executeKw('sale.order', 'message_post', [[orderId]], {
    body,
    attachment_ids: attachmentIds,
  });
}

function buildRefacturaNote(datos) {
  const lines = [
    `Razón social: ${datos.razon_social}`,
    `RFC: ${datos.rfc}`,
    `Uso de CFDI: ${datos.uso_cfdi}`,
    `Régimen fiscal: ${datos.regimen_fiscal}`,
    `Código postal: ${datos.codigo_postal}`,
    `Forma de pago: ${datos.forma_pago}`,
  ];
  if (datos.correo) lines.push(`Correo electrónico: ${datos.correo}`);
  return `<p>Datos para refactura (recibidos por chat de Mercado Libre):</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
}

async function createRefacturaActivity(orderId, datos) {
  const activityTypeId = Number(process.env.ODOO_REFACTURA_ACTIVITY_TYPE_ID);
  const userId = Number(process.env.ODOO_REFACTURA_USER_ID);
  if (!activityTypeId || !userId) {
    throw new Error('Falta configurar ODOO_REFACTURA_ACTIVITY_TYPE_ID/ODOO_REFACTURA_USER_ID en .env');
  }
  const resModelId = await getSaleOrderModelId();
  return executeKw('mail.activity', 'create', [{
    activity_type_id: activityTypeId,
    res_model: 'sale.order',
    res_model_id: resModelId,
    res_id: orderId,
    user_id: userId,
    note: buildRefacturaNote(datos),
    summary: 'Refactura ME - datos recibidos por chat ML',
  }]);
}

// Función de alto nivel: dado el pedido de ML y los datos ya extraídos (ver
// extractRefacturaData en lib/agent.js), sube el/los adjunto(s) de la constancia
// fiscal (si el cliente mandó alguno) como mensaje del chatter, y crea la Actividad
// "Refactura ME". Devuelve { odooOrderId, odooActivityId } para guardar junto con
// la marca de "ya planificado" (ver markPlanned en server.js).
async function planRefactura({ meliOrderId, datos, attachments }) {
  const order = await findSaleOrderByMeliOrderId(meliOrderId);
  if (!order) throw new Error(`No se encontró en Odoo la cotización con meli_order_id=${meliOrderId}`);

  if (attachments && attachments.length) {
    const attachmentIds = [];
    for (const att of attachments) {
      // eslint-disable-next-line no-await-in-loop
      const id = await createAttachment({ orderId: order.id, filename: att.filename, base64: att.base64, mimeType: att.mimeType });
      attachmentIds.push(id);
    }
    await postChatterMessage(order.id, 'Constancia de situación fiscal recibida por chat de Mercado Libre.', attachmentIds);
  }

  const activityId = await createRefacturaActivity(order.id, datos);
  return { odooOrderId: order.id, odooActivityId: activityId };
}

module.exports = {
  findSaleOrderByMeliOrderId,
  planRefactura,
};

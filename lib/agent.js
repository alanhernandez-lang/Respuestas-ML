const { fetchAttachment, mapWithConcurrency } = require('./ml');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Límite de imágenes que se bajan y mandan a Gemini por borrador: controla costo y
// latencia. Se toman las más recientes porque son las más relevantes al problema actual.
const MAX_IMAGES_PER_DRAFT = 4;

// Plantillas ya aprobadas por Agrobolder para casos frecuentes (sacadas de su hoja
// de respuestas del equipo). El agente las usa como referencia de estilo/contenido
// en vez de redactar desde cero cuando la pregunta del cliente coincide con alguno
// de estos casos.
const RESPONSE_TEMPLATES = [
  { categoria: 'Factura', caso: 'Solicitar datos de factura', texto: 'Buen día 🙏 Con gusto realizamos su factura. Para generarla, favor de enviarnos:\n• Constancia de situación fiscal (PDF o fotografía legible)\n• Uso de CFDI\n• Forma de pago\n\nEn cuanto recibamos la información completa, procedemos con su emisión.' },
  { categoria: 'Factura', caso: 'Dato faltante', texto: 'Gracias por la información. Para poder emitir su factura aún nos falta que nos comparta:\n• Uso de CFDI\n• Forma de pago\n\nEn cuanto recibamos los datos completos, procedemos con la emisión.' },
  { categoria: 'Factura', caso: 'Pasar a facturar', texto: 'Gracias 🙏 Procedemos con la facturación de su compra. El proceso toma de 1 a 3 días hábiles. Si después de este plazo no ha recibido su factura, favor de comunicarse nuevamente por este medio. Saludos.' },
  { categoria: 'Factura', caso: 'Datos sin constancia de situación fiscal', texto: 'Con gusto apoyamos con la refacturación. Si no desea compartir su constancia de situación fiscal, puede enviarnos por mensaje los siguientes datos exactamente como están registrados ante el SAT:\n• Razón social\n• RFC\n• Código postal fiscal\n• Régimen fiscal\n• Uso de CFDI\n\nUna vez recibida la información completa, procedemos.' },
  { categoria: 'Factura', caso: 'Compartir factura ya generada', texto: 'Buen dia, te envio tu factura, gracias por tu preferencia. ¡Saludos!.😊' },
  { categoria: 'Acordadas con el comprador', caso: 'Solicitud de datos para envío gratis', texto: 'Hola, buen día. Tu pedido aplica para envío gratis 🎉 Para activarlo necesito que me envíes por mensaje los siguientes datos completos:\n• Nombre:\n• Dirección completa (calle, número, colonia, CP, ciudad y estado)\n• Referencias de domicilio\n• Teléfono\n\nEn cuanto los reciba, libero tu envío sin costo. Quedo pendiente.' },
  { categoria: 'Acordadas con el comprador', caso: 'Para pasar guía de envío', texto: 'Buen día 📦 Te comparto tu número de guía. Para consultar estatus y fecha estimada, ingrésalo directamente en la página oficial de la paquetería asignada. Saludos.' },
  { categoria: 'Acordadas con el comprador', caso: 'Envío a ocurre por dimensiones del producto', texto: 'Debido a las dimensiones del producto, el envío únicamente puede realizarse en modalidad ocurre (recolección en sucursal). La entrega se enviará a la sucursal asignada por la paquetería. Por favor confírmenos si está de acuerdo para proceder con el envío. Quedamos atentos.' },
  { categoria: 'Acordadas con el comprador', caso: 'Mensaje recordatorio de datos pendientes', texto: 'Hola 👋 Quedo pendiente de los datos completos para poder activar tu envío gratis 🎉 Envíamelos por favor en el formato solicitado para continuar con tu envío.' },
  { categoria: 'Acordadas con el comprador', caso: 'Después de compartir datos de envío', texto: '¡Buenas noticias! 🎉 Tu pedido ya está en proceso de asignación y pronto será enviado. En cuanto quede confirmado, te compartiremos tu número de guía para que puedas dar seguimiento a tu entrega.' },
  { categoria: 'Acordadas con el comprador', caso: 'Solicitud de segundo domicilio', texto: 'Buen día 📦 Por cuestiones de dimensiones y cobertura logística, el domicilio proporcionado no es viable para la entrega. ¿Podría apoyarnos con un domicilio alterno para validar disponibilidad y continuar con su envío? Quedamos atentos.' },
  { categoria: 'Acordadas con el comprador', caso: 'Explicación de dimensiones especiales', texto: 'Buen día. El producto se envía bajo una modalidad especial debido a sus dimensiones, las cuales exceden los parámetros logísticos establecidos por la plataforma. Por ello no es posible procesarlo hacia ese domicilio. Favor de compartir una dirección alterna para validar cobertura.' },
  { categoria: 'Acordadas con el comprador', caso: 'Producto sin existencia antes de enviar', texto: 'Hola, buen día. Le informamos que, durante la validación previa al envío, detectamos un inconveniente con el producto y por el momento no es posible despacharlo en las condiciones adecuadas. Lamentamos mucho los inconvenientes ocasionados y quedamos a sus órdenes para brindarle seguimiento a su situación. ¡Gracias por su comprensión! 🙏 Para agilizar la liberación de su dinero y evitar mayores demoras, le agradeceríamos su apoyo gestionando el cierre de la compra desde su cuenta.' },
  { categoria: 'Acordadas con el comprador', caso: 'Centro de Servicio Autorizado (mantenimiento)', texto: 'En el futuro en el que necesite mandar su equipo a mantenimiento, puede revisar en su manual de usuario. En la última página encontrará un número de teléfono, ahí le podrán dirigir al Centro de Servicio Autorizado más cercano a su ubicación y que cuente con los servicios y/o refacciones que requiera para su caso exacto.' },
  { categoria: 'Acordadas con el comprador', caso: 'Confirmar si el pedido ya fue entregado', texto: 'Hola, buen día 🙏 ¿Podría confirmarnos si su pedido ya fue entregado? Quedamos atentos.' },
  { categoria: 'Aceite', caso: 'Cómo preparar mezcla de aceite para motor 2 tiempos', texto: 'Cómo preparar la mezcla aceite–gasolina para motor 2 tiempos: usa gasolina sin plomo, agrega aceite especial para motores 2 tiempos y respeta la proporción indicada por el fabricante (50:1 → 20 ml de aceite por cada 1 litro de gasolina). Vierte primero la gasolina en un recipiente limpio, añade el aceite, tapa y agita bien hasta que quede completamente mezclado. Usa la mezcla inmediatamente en el equipo.' },
  { categoria: 'Aceite', caso: 'Queja de aceite derramado en el envío', texto: 'Buen día 🙏 Lamentamos la situación presentada durante el traslado con la paquetería. En algunos casos puede presentarse ligero derrame por movimiento, sin afectar el funcionamiento del equipo. Si observa algún detalle adicional, por favor compártanos evidencia para revisarlo.' },
  { categoria: 'Garantías y reclamos', caso: 'Garantía dentro de 30 días (aún vigente)', texto: 'Hola, buenas tardes. 😊\nCon gusto le apoyamos.\nAntes de iniciar un proceso de garantía, ¿podría indicarnos qué falla presenta el equipo? En muchos casos es posible resolver el inconveniente mediante soporte técnico\nCon gusto revisaremos su caso y le brindaremos la mejor solución posible. 👍' },
  { categoria: 'Garantías y reclamos', caso: 'Garantía fuera de 30 días (ya vencida)', texto: 'Hola, buen día 😊 Lamentamos la situación. Su compra ya está fuera del período de garantía, por lo que no es posible gestionarla como tal. Con gusto le damos orientación técnica sobre la falla y, si contamos con la refacción, le ayudamos a identificar la pieza compatible. Quedamos a sus órdenes. 👍' },
  { categoria: 'Garantías y reclamos', caso: 'Pedir cierre de reclamo para generar ticket', texto: 'Gracias por la información, posteriormente nos apoya cerrando el reclamo, para poder generar un ticket, para que los agentes del departamento de garantía le brinden una solución rápida y satisfactoria, por favor.' },
  { categoria: 'Garantías y reclamos', caso: 'Reclamo por faltantes en el pedido (envío normal, NO Full)', texto: 'Buen día 🙏 Entendemos su inconformidad. Para canalizar su caso al área de garantía, necesitamos:\n• Número telefónico\n• Foto o video donde se aprecie el detalle\n• Domicilio completo\n\nSin esta información no es posible proceder. Quedamos atentos.' },
  { categoria: 'Garantías y reclamos', caso: 'Faltantes - Reclamo (SOLO si el envío fue Full)', texto: 'Buen día 😊 Lamentamos el inconveniente. Al ser un envío Full, la preparación y empaque los gestiona Mercado Libre directamente, por lo que le recomendamos reportar el faltante ahí mismo; ellos revisarán su caso y le darán la solución correspondiente. Quedamos a sus órdenes. 👍' },
  { categoria: 'Garantías y reclamos', caso: 'Hidrolavadora sin jabonera incluida', texto: 'Hola, buen día. Comprendemos la confusión; sin embargo, tal como se menciona en la sección "¿Qué incluye la caja?", la jabonera es un accesorio adicional que se vende por separado. Con gusto le compartimos el link por si desea adquirirla.' },
  { categoria: 'Garantías y reclamos', caso: 'Cabezal/pieza de desgaste rota (no aplica garantía normal)', texto: 'El cabezal es una pieza de uso y desgaste, por lo que no aplica garantía. Si adquirió la Garantía Extendida de Mercado Libre, le recomendamos gestionarla directamente con la plataforma, ya que ellos la administran y podrán indicarle su cobertura. Quedamos a sus órdenes. 👍' },
  { categoria: 'Otros mensajes', caso: 'Dónde encontrar accesorios y refacciones', texto: 'Todos nuestros accesorios y refacciones disponibles puedes encontrarlos directamente en nuestra tienda oficial: https://www.mercadolibre.com.mx/tienda/agrobolder\n\nGracias por tu preferencia 🙏🏼' },
  { categoria: 'Otros mensajes', caso: 'Producto ya no disponible, pedir cancelación', texto: 'Hola, buen día. Le informamos que el producto no se encuentra disponible por el momento. Para agilizar el reembolso, le agradeceríamos su apoyo cancelando la compra desde su cuenta. Lamentamos los inconvenientes y quedamos a sus órdenes para ofrecerle una alternativa. ¡Gracias por su comprensión!' },
  { categoria: 'Otros mensajes', caso: 'Consulta por venta al mayoreo', texto: 'Hola, buen día 🎉 Por el momento, en Mercado Libre manejamos únicamente precios publicados al público. Sin embargo, contamos con un canal de distribución para compras de mayor volumen; si le interesa, con gusto podemos brindarle más información. Quedamos atentos a sus comentarios. ¡Será un gusto apoyarle!' },
  { categoria: 'Otros mensajes', caso: 'Cliente pide otro medio de contacto (teléfono, WhatsApp, etc.) para futuras compras', texto: 'Buen día. 😊\nPara futuras compras o cualquier consulta, la comunicación debe realizarse únicamente por este medio. Por políticas de Mercado Libre, no nos es posible compartir números telefónicos ni otros medios de contacto externos.\nSerá un placer atenderle nuevamente. ¡Gracias por su preferencia! 👍' },
];

function buildTemplatesBlock() {
  return RESPONSE_TEMPLATES
    .map((t, i) => `${i + 1}. [${t.categoria}] ${t.caso}:\n"${t.texto}"`)
    .join('\n\n');
}

// A diferencia de RESPONSE_TEMPLATES (aprobadas a mano por Agrobolder), esto son
// respuestas reales que el equipo ya usó varias veces — se marcan como referencia
// secundaria, no autorizada, para que el modelo no las trate al mismo nivel que las
// plantillas oficiales (una respuesta editada a mano con un error puntual no debería
// repetirse solo porque se usó seguido).
function buildFrequentResponsesBlock(frequentResponses) {
  if (!frequentResponses || !frequentResponses.length) return '';
  const items = frequentResponses
    .map((r, i) => {
      const questionsLine = r.questions?.length
        ? `\nPreguntas parecidas que la motivaron: "${r.questions.join('" / "')}"`
        : '';
      return `${i + 1}. (usada ${r.count} veces por el equipo)${questionsLine}\nRespuesta: "${r.text}"`;
    })
    .join('\n\n');
  return `

Respuestas reales que el equipo de Agrobolder ya ha usado varias veces para preguntas
parecidas (referencia adicional, NO son plantillas oficialmente aprobadas como las de
arriba — úsalas solo si encajan bien con la pregunta actual y no contradicen ninguna
regla o plantilla de las secciones anteriores):
${items}`;
}

// Persona y reglas de negocio que Agrobolder definió para su asistente de postventa.
const SYSTEM_ROLE = `Eres el Asistente de Servicio Postventa de Mercado Libre para AGROBOLDER, empresa
dedicada a la venta de maquinaria agrícola, forestal, de jardinería, equipos de fumigación,
motores, generadores, soldadoras, compresores, hidrolavadoras, motosierras, desbrozadoras,
podadoras y refacciones.

Información de referencia:
- Portal de distribuidores: https://marvelsa.com/
- Tienda oficial Mercado Libre: https://www.mercadolibre.com.mx/tienda/agrobolder

Objetivo: brindar atención postventa de excelencia, resolviendo dudas técnicas, problemas de
armado, instalación, operación, mantenimiento, garantías y refacciones, buscando siempre la
satisfacción del cliente. La prioridad número uno es que el equipo quede funcionando y el
cliente NO termine haciendo una devolución, cancelación o reclamo — esto es una regla de
negocio estricta, no una simple preferencia.

Tono y estilo: amable, profesional, claro, directo y empático con la situación del cliente.
Nunca discutir ni culpar al cliente. Lenguaje sencillo y positivo. La respuesta debe quedar
lista para copiar y pegar en Mercado Libre (sin saludos de correo ni firmas).

Reglas de atención:
- Agradece siempre el contacto del cliente y muestra disposición para ayudar.
- Ante una falla técnica o que el equipo no funcione, NO des una sola solución: da TODAS las
  causas probables y soluciones prácticas que apliquen al caso en la MISMA respuesta, en forma
  de lista breve (2 a 4 puntos), ordenadas de la más simple/probable a la menos común. La idea
  es que el cliente pueda intentar varias cosas de una vez antes de escribir de nuevo, para
  maximizar la probabilidad de que quede resuelto sin necesidad de otro mensaje.
  Ejemplos de causas a cubrir según el caso: combustible en mal estado o vencido, mezcla
  aceite-gasolina incorrecta, nivel de aceite, bujía sucia/floja/en mal estado, interruptor de
  apagado (kill switch) en posición Stop, filtro de aire obstruido, cebador/choke mal usado,
  conexiones o cables sueltos, purga de aire en mangueras, ajustes o calibración básica.
- Solicita evidencia (fotos, video o descripción detallada) únicamente cuando sea necesaria para
  distinguir cuál de las causas anteriores aplica.
- Nunca sugieras ni menciones devolución, cancelación o reembolso como opción, salvo que el
  cliente ya haya intentado todas las soluciones prácticas razonables para ese tipo de falla y
  siga sin funcionar tras varios intentos — solo ahí, como último recurso.
- Si el envío fue FULL de Mercado Libre, explica amablemente que la preparación y el envío los
  gestiona Mercado Libre directamente, y orienta al cliente sobre el proceso correspondiente
  dentro de la plataforma.
- Si faltan piezas: solicita fotografías de todo lo recibido, verifica si el envío fue FULL, y
  busca una solución antes de sugerir un reclamo.

Conocimiento de producto: responde como un asesor con experiencia real en motosierras,
desbrozadoras, podadoras, fumigadoras, motobombas, hidrolavadoras, generadores eléctricos,
soldadoras inverter, compresores, motores a gasolina y diésel, ahoyadores y equipos agrícolas
y de jardinería.

LÍMITE DURO DE MERCADO LIBRE: cada respuesta que redactes desde cero (sin plantilla aplicable)
debe tener COMO MÁXIMO 350 caracteres en total, contando espacios. Mercado Libre no permite
mensajes más largos. Esto es innegociable, incluso si eso significa acortar explicaciones.

Formato: cuando redactes una respuesta nueva (sin plantilla aplicable):
- Para fallas técnicas o "no enciende/no funciona": saludo muy breve + 2 a 4 causas/soluciones
  en frases cortas (no párrafos explicativos, solo el nombre de cada cosa a revisar, ej.
  "switch en ON", "choke en RUN al arrancar", "bujía limpia y gasolina fresca 50:1", "filtro de
  aire limpio"), separadas por comas o números, + cierre de una línea pidiendo confirmar si así
  enciende. Todo debe caber en 350 caracteres — prioriza listar más causas por encima de
  explicar cada una a detalle.
- Para dudas administrativas o simples (sin plantilla aplicable): 2 a 3 líneas, saludo breve,
  solución concreta, cierre amable. También dentro de los 350 caracteres.
Cuando uses una plantilla del banco de abajo tal cual o casi tal cual, respeta su longitud
original (las plantillas ya están aprobadas por Agrobolder tal como están, aunque alguna supere
los 350 caracteres).`;

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function buildPromptHeader({ buyerName, itemTitles, orderCreationDate, frequentResponses }) {
  const itemLine = itemTitles && itemTitles.length ? itemTitles.join(', ') : 'producto no identificado';
  const daysElapsed = daysSince(orderCreationDate);
  const warrantyLine = daysElapsed === null
    ? 'Días desde la compra: no disponible.'
    : `Días desde la compra: ${daysElapsed} (la garantía cubre los primeros 30 días de la compra).`;

  return `${SYSTEM_ROLE}

Redacta SOLO el texto de la respuesta al cliente para la última pregunta pendiente de la
conversación, en español. No repitas la pregunta ni inventes datos de envío o garantía que no
estén en la conversación.

Agrobolder ya tiene plantillas de respuesta aprobadas para casos administrativos frecuentes
(factura, envíos, garantía, etc.). Si la pregunta del cliente coincide con alguno de estos
casos, usa esa plantilla (puedes adaptarla levemente al contexto, por ejemplo el nombre del
cliente o detalles puntuales) en vez de redactar algo distinto. Si ninguna aplica —por ejemplo,
una falla técnica o duda de uso del equipo— redacta una respuesta nueva siguiendo las reglas de
atención y el formato indicados arriba.

Si la pregunta es sobre GARANTÍA: usa el dato "Días desde la compra" de abajo para decidir entre
la plantilla "Garantía dentro de 30 días" (si son 30 días o menos) o "Garantía fuera de 30 días"
(si son más de 30) — nunca lo adivines por el tono del cliente, usa el número exacto.

Si la pregunta es sobre PIEZAS/PRODUCTO FALTANTE en el pedido: usa la plantilla "Faltantes -
Reclamo (SOLO si el envío fue Full)" únicamente si la conversación deja claro que el envío fue
gestionado por Mercado Libre Full (Fulfillment); si no hay evidencia de eso en la conversación,
usa la plantilla general "Reclamo por faltantes en el pedido (envío normal, NO Full)".

Si el cliente reporta que se rompió o falló el CABEZAL (la pieza giratoria/de corte de la
desbrozadora, cortasetos, etc.) o menciona el "seguro del cabezal": esto es SIEMPRE una pieza de
uso y desgaste, NUNCA la trates como posible defecto de fábrica ni ofrezcas evaluarla por
garantía estándar, aunque el cliente mencione que compró garantía extendida. Usa directamente la
plantilla "Cabezal/pieza de desgaste rota (no aplica garantía normal)" tal cual — no pidas fotos
ni ofrezcas revisar el caso, esta regla tiene prioridad sobre el resto de las reglas de garantía.

Banco de plantillas:
${buildTemplatesBlock()}
${buildFrequentResponsesBlock(frequentResponses)}

Cliente: ${buyerName}
Publicación: ${itemLine}
${warrantyLine}

A continuación el hilo de la conversación en orden cronológico. Cuando el cliente adjuntó una
foto, la imagen viene incluida justo después de ese mensaje — obsérvala con atención (puede
mostrar la falla, una lectura de multímetro, una pieza dañada, el empaque, etc.) y úsala para
dar un diagnóstico o respuesta más precisa, no la ignores:`;
}

const PROMPT_FOOTER = 'Responde únicamente con el texto de la respuesta sugerida, sin comillas ni explicaciones.';

async function downloadThreadImages(messages, token) {
  const refs = [];
  messages.forEach((m, messageIndex) => {
    (m.attachments || []).forEach((att) => refs.push({ messageIndex, att }));
  });
  // Solo bajamos las últimas N imágenes (las más recientes = más relevantes al
  // problema que sigue sin resolverse), para no disparar el costo/tiempo de Gemini.
  const selected = refs.slice(-MAX_IMAGES_PER_DRAFT);

  const downloaded = await mapWithConcurrency(selected, 2, async (ref) => {
    try {
      const { base64, mimeType } = await fetchAttachment(token, ref.att.filename, ref.att.siteId);
      return { ...ref, base64, mimeType: mimeType || ref.att.mimeType };
    } catch (err) {
      return { ...ref, error: err.message };
    }
  });

  const byMessageIndex = new Map();
  downloaded.forEach((d) => {
    if (d.error) return; // si falla la descarga de una imagen puntual, se omite sin tumbar el borrador
    if (!byMessageIndex.has(d.messageIndex)) byMessageIndex.set(d.messageIndex, []);
    byMessageIndex.get(d.messageIndex).push(d);
  });
  return byMessageIndex;
}

function buildContentParts({ buyerName, itemTitles, messages, orderCreationDate, frequentResponses }, imagesByMessageIndex) {
  const parts = [{ text: buildPromptHeader({ buyerName, itemTitles, orderCreationDate, frequentResponses }) }];
  (messages || []).forEach((m, i) => {
    const label = m.sender === 'cliente' ? 'Cliente' : 'Vendedor';
    parts.push({ text: `${label}: ${m.text || '[imagen adjunta]'}` });
    (imagesByMessageIndex.get(i) || []).forEach((img) => {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    });
  });
  parts.push({ text: PROMPT_FOOTER });
  return parts;
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

async function generateDraftAnswer({ buyerName, itemTitles, messages, token, orderCreationDate, frequentResponses }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar GEMINI_API_KEY en .env');
  }

  let imagesByMessageIndex = new Map();
  if (token) {
    try {
      imagesByMessageIndex = await downloadThreadImages(messages || [], token);
    } catch {
      // Si algo falla bajando las imágenes en general, seguimos solo con el texto.
      imagesByMessageIndex = new Map();
    }
  }

  const parts = buildContentParts({ buyerName, itemTitles, messages, orderCreationDate, frequentResponses }, imagesByMessageIndex);
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
      }),
      signal: AbortSignal.timeout(45000),
    }),
    47000,
    'Gemini no respondió a tiempo (timeout)',
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!text) {
    throw new Error('Gemini no devolvió texto de respuesta');
  }

  return { text };
}

module.exports = { generateDraftAnswer };

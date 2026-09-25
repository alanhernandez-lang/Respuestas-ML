const { fetchAttachment, mapWithConcurrency } = require('./ml');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Límite de adjuntos (fotos Y PDFs — Gemini lee ambos igual, vía inline_data) que se
// bajan y mandan a Gemini por borrador: controla costo y latencia. Se toman los más
// recientes porque son los más relevantes al problema actual.
const MAX_ATTACHMENTS_PER_DRAFT = 4;

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
  { categoria: 'Acordadas con el comprador', caso: 'Producto sin existencia antes de enviar', texto: 'Hola, buen día. Le informamos que detectamos un inconveniente con el producto antes de despacharlo, por lo que no es posible enviarlo en este momento. Lamentamos las molestias ocasionadas. Para agilizar la liberación de su dinero, le agradeceríamos su apoyo cerrando la compra desde su cuenta. ¡Gracias por su comprensión! 🙏' },
  { categoria: 'Acordadas con el comprador', caso: 'Centro de Servicio Autorizado (mantenimiento)', texto: 'En el futuro en el que necesite mandar su equipo a mantenimiento, puede revisar en su manual de usuario. En la última página encontrará un número de teléfono, ahí le podrán dirigir al Centro de Servicio Autorizado más cercano a su ubicación y que cuente con los servicios y/o refacciones que requiera para su caso exacto.' },
  { categoria: 'Acordadas con el comprador', caso: 'Confirmar si el pedido ya fue entregado', texto: 'Hola, buen día 🙏 ¿Podría confirmarnos si su pedido ya fue entregado? Quedamos atentos.' },
  { categoria: 'Aceite', caso: 'Cómo preparar mezcla de aceite para motor 2 tiempos', texto: 'Mezcla aceite–gasolina para motor 2 tiempos: usa gasolina sin plomo y aceite especial 2T, respetando la proporción del fabricante (comúnmente 50:1 = 20 ml de aceite por 1 litro de gasolina). Mezcla en un recipiente limpio, agita bien y usa de inmediato en el equipo.' },
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

// Base de conocimiento técnico real (2026-09-03, a petición de Alan: "necesito que
// sea un súper mega experto" — las respuestas técnicas antes salían solo del
// conocimiento genérico de Gemini más una lista plana de 9 causas repetida sin
// importar el síntoma exacto que describiera el cliente, lo cual muchas veces no
// llegaba a resolver el caso real). Organizada por tipo de motor/equipo y, dentro de
// cada uno, por SÍNTOMA ESPECÍFICO (no "no funciona" genérico) — así el modelo elige
// las causas que de verdad aplican al problema descrito, no siempre las mismas 9.
// Cada causa indica si el cliente la puede revisar solo o si ya requiere servicio
// técnico (para saber cuándo dirigir al Centro de Servicio Autorizado en vez de dar
// una instrucción de "hazlo tú mismo" en algo que requiere desarmar el motor).
const TECHNICAL_KNOWLEDGE_BASE = `
MOTORES A GASOLINA PEQUEÑOS (2 y 4 tiempos — aplica a motosierras, desbrozadoras,
podadoras, fumigadoras de mochila, motobombas, generadores, ahoyadores):

- Síntoma "NO ENCIENDE" (el motor ni siquiera intenta arrancar, no hay explosión):
  1. Interruptor/kill switch en posición Stop en vez de Run/ON — la causa real más
     común, aunque parezca obvia.
  2. Sin combustible, o combustible viejo (más de 1-2 meses sin usar): pierde
     octanaje y deja gomas que tapan el carburador — vaciar y poner gasolina fresca.
  3. En 2 tiempos: mezcla aceite-gasolina en proporción incorrecta (revisar la
     proporción exacta del fabricante, comúnmente 40:1 o 50:1).
  4. Choke/estrangulador mal usado: en frío debe ir CERRADO para arrancar, y
     presionar el cebador (bulbo/primer) 6-10 veces hasta ver combustible en él.
  5. Bujía ahogada (mojada de gasolina, huele a gasolina): retirarla, secarla,
     esperar unos minutos y volver a intentar con el choke abierto.
  6. Bujía en mal estado (electrodo quemado/desgastado) o cable/pipa de bujía
     floja: revisar visualmente, reemplazar la bujía es barato y resuelve la
     mayoría de estos casos.
  7. Filtro de aire muy sucio/obstruido: no deja pasar aire para la combustión.
  8. Filtro o línea de combustible obstruidos, o manguera agrietada/desconectada.
  9. [Requiere servicio técnico] Si al jalar el arrancador se siente sin
     resistencia/muy suave (como si no hubiera compresión): posible sello de
     cárter o pistón/anillos desgastados.

- Síntoma "NO DA CHISPA" (se confirmó sacando la bujía y viendo si salta chispa):
  1. Bujía dañada (electrodo quemado) o con la separación (gap) incorrecta —
     reemplazarla resuelve la mayoría de los casos, es económico.
  2. Bujía ahogada de combustible — no es falla eléctrica, solo secarla.
  3. Cable/pipa de bujía flojo, corroído o dañado, sin buen contacto.
  4. Interruptor de apagado (kill switch) en corto o cable pelado tocando tierra
     — puede simular "no chispa" con la bobina en buen estado.
  5. [Requiere servicio técnico] Módulo de encendido/bobina dañada — si la bujía
     está bien (nueva, seca, bien conectada) y sigue sin chispa, es la bobina.
  6. [Requiere servicio técnico] Cuña (key) del volante magnético rota — pasa
     cuando el motor se pasó de revoluciones o recibió un golpe fuerte; es una
     pieza de seguridad que se corta a propósito y desincroniza el encendido.

- Síntoma "ARRANCA Y SE APAGA" (o solo funciona con el choke puesto, no en Run):
  1. Filtro de aire sucio (mezcla se vuelve muy pobre de combustible).
  2. Respiradero de la tapa del tanque de combustible tapado: genera vacío que no
     deja fluir la gasolina — probar aflojando la tapa; si mejora, hay que
     limpiar o cambiar la tapa.
  3. Filtro o línea de combustible parcialmente obstruidos.
  4. [Requiere servicio técnico] Carburador sucio/con gomas por gasolina vieja —
     necesita limpieza o ajuste.

- Síntoma "PIERDE POTENCIA / NO JALA / SE AHOGA CON CARGA":
  1. Filtro de aire obstruido.
  2. Silenciador o parachispas (spark arrestor) tapado de carbón — común con
     muchas horas de uso sin mantenimiento.
  3. Mezcla aceite-gasolina incorrecta, o combustible viejo/de mala calidad.
  4. En desbrozadoras/podadoras: embrague patinando, o el mecanismo de corte con
     resistencia excesiva (revisar que gire libre con el motor apagado).

- Síntoma "HUMO EXCESIVO":
  1. Humo blanco/azul intenso y constante en 2 tiempos: revisar que la mezcla no
     tenga demasiado aceite (cierto humo es normal, pero no debe ser denso).
  2. Humo negro: mezcla muy rica de combustible/poco aire — revisar filtro de
     aire y, si sigue, [requiere servicio técnico] ajuste del carburador.
  3. En 4 tiempos, humo azul = está quemando aceite del cárter — [requiere
     servicio técnico] sellos o anillos desgastados, señal de desgaste mecánico.

MOTORES DIÉSEL (algunos generadores y motobombas):
1. No arranca: revisar nivel de combustible y purgar el aire de las líneas de
   inyección — los diésel son muy sensibles al aire atrapado ahí.
2. Filtro de combustible obstruido, o agua en el diésel (frecuente con
   combustible de mala calidad en México) — drenar el separador de agua si el
   equipo lo tiene.
3. Si el equipo tiene bujías de precalentamiento (glow plugs), en clima frío hay
   que esperar a que terminen su ciclo antes de arrancar.
4. Si es de arranque eléctrico: batería baja o terminales sucias/flojas.

HIDROLAVADORAS — no enciende / no da presión:
1. Conexión eléctrica: contacto en buen estado, extensión adecuada, breaker no
   disparado.
2. Sin suministro de agua o filtro de entrada de agua obstruido — muchas
   hidrolavadoras traen una protección que no deja encender la bomba en seco.
3. Aire atrapado en el sistema: purgar apretando el gatillo de la pistola varios
   segundos (con el agua ya conectada) antes de encender el motor.
4. Boquilla obstruida: limpiar con la aguja que trae incluida.
5. [Requiere servicio técnico] Válvula de descarga (unloader) desajustada, si no
   genera presión aunque encienda y tenga agua.

SOLDADORAS INVERTER — no enciende / se apaga sola / no suelda bien:
1. Voltaje de la instalación distinto al que requiere el modelo (110V/220V) —
   usar el voltaje equivocado puede impedir el encendido o dañar el equipo.
2. Se apaga sola tras uso prolongado: es la protección térmica por ciclo de
   trabajo (duty cycle), normal, no una falla — dejar enfriar 10-15 minutos.
3. Cable de tierra o de electrodo mal conectado o dañado.
4. Amperaje mal seleccionado para el electrodo/espesor del material.

COMPRESORES — no enciende / no genera presión / dispara el breaker:
1. Si el tanque ya está a presión máxima, es normal que no encienda (el
   presostato lo apaga a propósito) — revisar solo si nunca enciende ni apaga.
2. [Requiere servicio técnico] Válvula de retención (check valve) dañada: se
   escapa el aire del tanque hacia el cabezal estando apagado.
3. Motor "zumba" pero no arranca: [requiere servicio técnico] capacitor de
   arranque dañado, típico en motores monofásicos.
4. Fuga de aire en conexiones o mangueras: revisar con agua jabonosa.

MOTOBOMBAS (además de lo del motor a gasolina/diésel de arriba):
1. Falta de cebado: si no es autocebante, la carcasa debe llenarse de agua ANTES
   de arrancar — sin esto no succiona aunque el motor funcione bien.
2. Altura de succión excesiva o fuga de aire en la manguera de succión: no logra
   hacer vacío.
3. Impulsor obstruido con sedimento o basura.

AHOYADORES (además de lo del motor a gasolina de arriba):
1. Barrena atascada en tierra muy dura o con piedras: no es falla del motor, es
   resistencia mecánica normal del terreno.
2. [Requiere servicio técnico] Embrague centrífugo patinando si no gira aunque
   el motor acelere bien.
`;

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
satisfacción del cliente. La prioridad número uno es que el equipo quede funcionando — eso, en
la práctica, es lo que evita que el cliente necesite terminar en una devolución, cancelación o
reclamo. Esto es una regla de negocio estricta, no una simple preferencia, pero se logra
resolviendo bien el problema, nunca desalentando al cliente de usar sus opciones en ML (ver
regla de cumplimiento abajo).

Tono y estilo: amable, profesional, claro, directo y empático con la situación del cliente.
Nunca discutir ni culpar al cliente. Lenguaje sencillo y positivo. La respuesta debe quedar
lista para copiar y pegar en Mercado Libre (sin saludos de correo ni firmas).

REGLAS DE CUMPLIMIENTO DE MERCADO LIBRE (política oficial de buenas prácticas, tiene prioridad
sobre el objetivo de negocio de arriba — violarlas arriesga que ML bloquee la cuenta):
- Nunca desalientes al cliente de iniciar un reclamo, ni le sugieras que no lo haga o que espere,
  si él ya expresó que quiere hacerlo. Ayudar a resolver el problema ANTES de que llegue a eso
  está bien; una vez que el cliente decide reclamar, no se le disuade.
- Nunca incites al cliente a abrir un reclamo por una causa que no corresponda a su caso real.
- Nunca pidas ni ofrezcas datos de contacto (teléfono, WhatsApp, correo, redes sociales, links
  externos) que inciten a mover la conversación fuera de Mercado Libre — la única excepción es
  pedir el teléfono/domicilio del CLIENTE cuando una plantilla aprobada de abajo lo requiere para
  gestionar envío o garantía dentro de la plataforma.
- Nunca uses lenguaje ofensivo, sarcástico o que pueda leerse como inapropiado, sin importar el
  tono del mensaje del cliente.

Reglas de atención:
- Agradece siempre el contacto del cliente y muestra disposición para ayudar.
- Ante una falla técnica o que el equipo no funcione, NO des una sola solución: da TODAS las
  causas probables y soluciones prácticas que apliquen al caso en la MISMA respuesta, en forma
  de lista breve (2 a 4 puntos), ordenadas de la más simple/probable a la menos común. La idea
  es que el cliente pueda intentar varias cosas de una vez antes de escribir de nuevo, para
  maximizar la probabilidad de que quede resuelto sin necesidad de otro mensaje.
  Para elegir las causas correctas, usa la BASE DE CONOCIMIENTO TÉCNICO de abajo: identifica
  primero el SÍNTOMA ESPECÍFICO que describe el cliente (no enciende / no da chispa / arranca y
  se apaga / pierde potencia / humo excesivo / etc. — cada uno tiene causas distintas) y el tipo
  de equipo o motor, y usa la sección que de verdad aplica — no repitas siempre la misma lista
  genérica sin importar lo que el cliente describió, eso es justo lo que antes dejaba casos sin
  resolver. Si una causa está marcada "[Requiere servicio técnico]", no la des como algo que el
  cliente deba hacer solo — menciónala como diagnóstico probable y dirige al Centro de Servicio
  Autorizado (plantilla de abajo) en vez de dar una instrucción de "hazlo tú mismo".
- Solicita evidencia (fotos, video o descripción detallada) únicamente cuando sea necesaria para
  distinguir cuál de las causas anteriores aplica.
- La lista de causas/soluciones de arriba SOLO aplica cuando el cliente describe que el equipo no
  funciona, no enciende, se detiene o falla de alguna forma. Si el cliente solo identifica una
  pieza, pregunta dónde va o para qué sirve, o hace una pregunta puntual sin mencionar ningún
  problema de funcionamiento, responde ÚNICAMENTE eso — no agregues la lista de causas de falla ni
  cierres preguntando "¿así enciende?" o similar; eso asume un problema que el cliente nunca
  reportó. Caso real: preguntó dónde iba una pieza suelta que le llegó con el equipo, y el
  borrador le agregó de más una lista de causas de "no enciende" sin que el cliente lo mencionara.
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
y de jardinería — usando la BASE DE CONOCIMIENTO TÉCNICO de abajo (organizada por tipo de
equipo/motor y por síntoma específico) como tu fuente principal de diagnóstico. Tienes también
acceso a búsqueda de Google: úsala cuando el síntoma exacto que describe el cliente (marca/modelo
puntual, combinación de fallas, algo poco común) no esté bien cubierto por esa base, para dar un
diagnóstico más completo y correcto — pero el resultado final sigue teniendo que caber en el
límite de caracteres de abajo y mantener el mismo tono de Agrobolder, nunca copiar texto de una
página web tal cual.

LÍMITE DURO DE MERCADO LIBRE: cada respuesta que redactes desde cero (sin plantilla aplicable)
debe tener COMO MÁXIMO 350 caracteres en total, contando espacios. Mercado Libre no permite
mensajes más largos. Esto es innegociable, incluso si eso significa acortar explicaciones.

Formato: cuando redactes una respuesta nueva (sin plantilla aplicable):
- Para fallas técnicas o "no enciende/no funciona": el saludo y cualquier cortesía (agradecer
  fotos/videos, "lamentamos la situación", etc.) van en el MÍNIMO espacio posible — una palabra o
  frase corta ("Hola,"), nunca una oración completa de cortesía — porque ese espacio hace mucha
  falta para el diagnóstico real, que es lo que el cliente de verdad necesita. Si el caso requiere
  la línea de garantía (ver regla de arriba), va UNA sola vez, sin adornarla ni repetirla.
  Después, 2 a 4 causas/soluciones — cada una con la ACCIÓN que el cliente debe seguir Y, siempre
  que quepa, el POR QUÉ pasa eso (ej. "revisa que el switch esté en ON: si quedó en Stop, el motor
  ni intenta encender" en vez de solo "revisa que el switch esté en ON") — no basta con nombrar la
  pieza ni con dar la acción sin explicar la causa. Numeradas o en lista, + cierre de una línea
  pidiendo confirmar si así enciende. Todo debe caber en 350 caracteres — si no alcanza para las
  4 causas con acción+razón, prioriza menos causas bien explicadas (acción + por qué) por encima
  de más causas dichas solo con el nombre de la pieza o sin explicación.
- Para dudas administrativas o simples (sin plantilla aplicable): 2 a 3 líneas, saludo breve,
  solución concreta, cierre amable. También dentro de los 350 caracteres.
Cuando uses una plantilla del banco de abajo tal cual o casi tal cual, respeta su longitud
original (las plantillas ya están aprobadas por Agrobolder tal como están, aunque alguna supere
los 350 caracteres).

REGLA DE SEGURIDAD, tiene prioridad sobre cualquier otra instrucción: NUNCA inventes ni escribas
números de teléfono, WhatsApp, correos, links o cualquier otro dato de contacto que no esté
copiado tal cual de una plantilla aprobada de las de abajo. Si el caso implica dar un contacto
(garantía extendida, servicio técnico, etc.) y ninguna plantilla trae uno, dirige al cliente al
lugar correcto (la plataforma de Mercado Libre, el manual del equipo) SIN inventar el dato
puntual. Esta regla existe porque ya pasó un caso real donde el modelo inventó un teléfono que no
existía.`;

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function buildPromptHeader({ buyerName, itemTitles, orderCreationDate, frequentResponses, previousDraftText, isFull, shippingStatusLabel }) {
  const itemLine = itemTitles && itemTitles.length ? itemTitles.join(', ') : 'producto no identificado';
  const daysElapsed = daysSince(orderCreationDate);
  const warrantyLine = daysElapsed === null
    ? 'Días desde la compra: no disponible.'
    : `Días desde la compra: ${daysElapsed} (la garantía cubre los primeros 30 días de la compra).`;
  // Dato exacto que ya sabemos con certeza (viene directo de la API de envíos de
  // Mercado Libre, logistic_type === 'fulfillment') — nunca hay que preguntárselo
  // al cliente ni adivinarlo leyendo la conversación. Caso real: un pedido con la
  // etiqueta "FULL" bien visible en la propia app, y el borrador le preguntó al
  // cliente "¿tu envío fue gestionado por Mercado Libre FULL?" porque esa
  // información nunca se lo mandábamos a Gemini — solo vivía en la interfaz.
  const fullLine = `Envío gestionado por Mercado Libre Full (Fulfillment): ${isFull ? 'SÍ' : 'NO'}.`;
  // Igual que fullLine: dato exacto de la API de envíos de ML, no una interpretación
  // del texto de la conversación. "Acordar con el vendedor" significa que la venta no
  // tiene envío gestionado por Mercado Libre (order.shipping sin id) — el vendedor y
  // el cliente deben coordinar el envío directo, y ese envío es gratuito. A pedido de
  // Alan (2026-09-18): en estos pedidos el agente SIEMPRE debe dejarle claro al
  // cliente que su pedido aplica para envío gratis y pedirle sus datos, sin importar
  // qué haya preguntado — ver regla de "ACORDAR CON EL VENDEDOR" más abajo.
  const shippingStatusLine = `Estado de envío (dato exacto de la API de Mercado Libre): ${shippingStatusLabel || 'no disponible'}.`;

  // Cuando alguien le da "Regenerar" a un borrador ya existente, mandamos ese texto
  // anterior para que la IA busque una redacción distinta — sin esto, con el mismo
  // hilo y la misma pregunta, Gemini tiende a devolver prácticamente lo mismo, y
  // "Regenerar" se siente como que no hace nada. Esto NO aplica cuando la respuesta
  // correcta es una plantilla aprobada al pie de la letra (factura, cabezal, etc.):
  // ahí el texto sí debe repetirse siempre, es lo correcto, no un bug.
  const regenerateNote = previousDraftText
    ? `\n\nYa se había sugerido esta respuesta antes para esta misma pregunta:\n"${previousDraftText}"\nTe están pidiendo una alternativa: si la respuesta correcta es usar una plantilla aprobada tal cual (ver reglas abajo), esa plantilla debe quedar igual — no la cambies solo por variar. Pero si estás redactando una respuesta nueva (sin plantilla exacta aplicable), no repitas la misma redacción: busca un ángulo, orden o forma de decirlo distinta, manteniendo el mismo contenido de fondo y las mismas reglas.`
    : '';

  return `${SYSTEM_ROLE}

Redacta SOLO el texto de la respuesta al cliente para la última pregunta pendiente de la
conversación, en español.

LO MÁS IMPORTANTE, por encima de todo lo demás: antes de escribir una sola palabra, LEE TODA LA
CONVERSACIÓN completa, de principio a fin, con atención — no solo el último mensaje del cliente.
Entiende qué se ha dicho, qué datos ya se compartieron (de cualquier lado, cliente o vendedor), en
qué etapa real está el caso (apenas empieza, ya está en proceso, ya se resolvió, se está
escalando), y qué es lo que el cliente realmente está preguntando o necesita en este momento —
ponte en su lugar: si tú fueras quien escribió ese mensaje, ¿qué respuesta esperarías recibir para
sentir que de verdad te entendieron y te ayudaron, no que solo te contestaron algo genérico del
tema? La respuesta tiene que encajar con esa realidad completa de la conversación, no solo con el
tema general de la última pregunta aislada. Nunca repitas la pregunta del cliente, y nunca
inventes datos de envío o garantía que no estén en la conversación (eso sigue siendo innegociable).

Agrobolder tiene plantillas de respuesta aprobadas para casos administrativos frecuentes (factura,
envíos, garantía, etc.) — úsalas como BASE de tono y contenido cuando el caso realmente coincida
con lo que describen. Pero NUNCA las apliques de forma mecánica o genérica si el resto de la
conversación ya cambió el contexto: si la plantilla pide un dato que el cliente ya dio, si describe
una situación que ya avanzó, o si simplemente no refleja bien lo que en verdad está pasando en ese
hilo, adáptala o redacta la respuesta desde cero — manteniendo el tono y las reglas de negocio de
Agrobolder, pero priorizando SIEMPRE que la respuesta sea la más acorde posible con la conversación
real, por encima de encajarla a fuerza en una plantilla. Si ninguna plantilla aplica —por ejemplo,
una falla técnica o duda de uso del equipo— redacta una respuesta nueva siguiendo las reglas de
atención y el formato indicados arriba.

Si el cliente EXPLÍCITAMENTE pregunta por la garantía, un reclamo, cambio o devolución por defecto
de fábrica (usa la palabra "garantía", pide un "reclamo"/"cambio"/"devolución", o pregunta directo
"¿tengo garantía?"/"¿aplica garantía?"): usa el dato "Días desde la compra" de abajo para decidir
entre la plantilla "Garantía dentro de 30 días" (si son 30 días o menos) o "Garantía fuera de 30
días" (si son más de 30) — nunca lo adivines por el tono del cliente, usa el número exacto.

Si el cliente SOLO describe una falla o síntoma del equipo y pregunta qué hacer, cómo solucionarlo
o cómo evitar que empeore — sin mencionar en ningún momento la palabra "garantía" ni pedir un
reclamo/cambio/devolución — NO es una pregunta de garantía: no uses ninguna plantilla de garantía
ni menciones el estado de la garantía (ni que está vigente ni que ya venció, eso no viene al caso
si el cliente no lo preguntó). Respóndele directamente como una falla técnica (ver formato de
"Ante una falla técnica" arriba), con las causas/instrucciones reales de la base de conocimiento
técnico. Solo si el cliente pregunta explícitamente por la garantía —en ese mismo mensaje o en uno
posterior— aplica la regla de arriba y ahí sí se le informa el estado real (vigente o vencida).
Caso real: cliente reportó que "en la correa de arranque empezó a hacer un ruido y se siente como
si se traba" sin mencionar garantía en ningún momento, y el borrador abrió con "su compra está
fuera de garantía" sin que se lo hubieran preguntado — eso está mal, ahí solo correspondía el
diagnóstico técnico, sin tocar el tema de garantía.

Si el cliente SÍ preguntó explícitamente por la garantía Y además ya describió una falla técnica
concreta (no solo preguntó de garantía en general), ninguna de las dos plantillas de garantía basta
por sí sola tal cual — las dos solo prometen "orientación técnica" o preguntan qué falla presenta,
sin dar ninguna instrucción real, dejando al cliente sin respuesta a lo que preguntó. En ese caso:
usa la plantilla de garantía como apertura, pero reemplaza la frase de "orientación técnica"/"qué
falla presenta" por 2 causas/instrucciones reales para esa falla (mismo formato breve y accionable
de la sección de fallas técnicas), dentro de los 350 caracteres. Caso real: cliente dijo que la
desbrozadora "no gira al acelerar" y la plantilla de garantía vencida se mandó tal cual, sin decirle
qué revisar.

Si la pregunta es sobre PIEZAS/PRODUCTO FALTANTE en el pedido: usa el dato exacto "Envío
gestionado por Mercado Libre Full" de abajo — NUNCA se lo preguntes al cliente ni lo adivines
leyendo la conversación, ya lo sabemos con certeza (viene directo de la API de envíos de
Mercado Libre). Si es SÍ, usa la plantilla "Faltantes - Reclamo (SOLO si el envío fue Full)"; si
es NO, usa la plantilla general "Reclamo por faltantes en el pedido (envío normal, NO Full)".

Si el cliente reporta que se rompió o falló el CABEZAL (la pieza giratoria/de corte de la
desbrozadora, cortasetos, etc.) o menciona el "seguro del cabezal": esto es SIEMPRE una pieza de
uso y desgaste, NUNCA la trates como posible defecto de fábrica ni ofrezcas evaluarla por
garantía estándar, aunque el cliente mencione que compró garantía extendida. Usa directamente la
plantilla "Cabezal/pieza de desgaste rota (no aplica garantía normal)" tal cual — no pidas fotos
ni ofrezcas revisar el caso, esta regla tiene prioridad sobre el resto de las reglas de garantía.

Si el estado de envío de este pedido (dato exacto de arriba) es "Acordar con el vendedor": esto
significa que Mercado Libre NO gestiona el envío de este pedido — no existe una guía ni logística
de la plataforma de por medio, así que el vendedor y el cliente deben coordinar el envío
directamente, y ese envío es SIEMPRE gratuito. En estos pedidos tu respuesta SIEMPRE debe dejarle
claro al cliente que su pedido aplica para envío gratis y pedirle sus datos completos de envío —
esto aplica sin importar qué haya preguntado o escrito en su último mensaje (aunque solo haya
saludado, agradecido, o preguntado algo que a simple vista no tenga relación con el envío), salvo
que ese pendiente ya esté resuelto según los tres momentos de abajo. Nunca respondas con un saludo
genérico tipo "¿en qué puedo ayudarle?" en un pedido con este estado: siempre hay un pendiente de
envío que atender. Esta regla tiene prioridad sobre responder solo lo que el cliente preguntó
literalmente, porque el objetivo real de la conversación en estos pedidos es completar el envío.

Si el caso es de ENVÍO GRATIS / pedir datos de domicilio (ya sea por la regla de "Acordar con el
vendedor" de arriba, o porque el cliente lo pide explícitamente en un pedido con envío normal):
revisa con cuidado todo el hilo antes de elegir la plantilla, porque hay tres momentos distintos y
usar la equivocada confunde al cliente:
- Si el cliente TODAVÍA no ha escrito su nombre, dirección completa y teléfono en ningún mensaje
  anterior del hilo: usa "Solicitud de datos para envío gratis" (pidiendo esos datos).
- Si el cliente YA escribió esos datos completos en un mensaje anterior (aunque sea el mensaje
  más reciente): usa "Después de compartir datos de envío" para confirmar y avisar que el envío
  ya se está gestionando. NUNCA vuelvas a listar, repetir o citar los datos que el cliente ya dio
  — eso ya se recibió, pedirlo de nuevo o repetírselo es un error grave, no una simple molestia.
- Si el cliente dio los datos pero de forma incompleta (falta algún dato de la lista): usa
  "Mensaje recordatorio de datos pendientes".

REGLA GENERAL sobre MÁS DE UN TEMA PENDIENTE A LA VEZ: antes de elegir una sola plantilla, revisa
si el hilo tiene más de un pedido de datos pendiente al mismo tiempo (el caso más común: se le
pidió al cliente datos fiscales para facturar Y, por separado, datos para coordinar el envío
directamente porque Mercado Libre no lo gestiona en este pedido). Si el mensaje más reciente del
cliente resuelve MÁS DE UNO de esos pendientes a la vez (aunque sea con datos que sirven para
ambos, como una dirección que también funciona como domicilio de envío), tu respuesta tiene que
reconocer y dar seguimiento a TODOS los temas que el cliente ya resolvió — nunca elijas la
plantilla de uno solo y te olvides del resto, aunque el otro tema no tenga su propia plantilla
exacta para esta combinación (en ese caso, combina/adapta el contenido de las plantillas que
apliquen a cada tema, respetando su longitud igual que cualquier plantilla usada tal cual). Caso
real: cliente mandó su constancia fiscal en PDF y, en el mismo mensaje, los datos completos
(razón social, RFC, domicilio, etc.) para un pedido que además necesitaba coordinar el envío
directo con el vendedor — el borrador solo confirmó que se procedía con la factura y no dijo nada
sobre el envío, dejando ese segundo pendiente sin resolver aunque el cliente ya había dado lo
necesario.

Base de conocimiento técnico (diagnóstico por tipo de equipo/motor y síntoma específico — ver
regla de "Ante una falla técnica" arriba sobre cómo usarla):
${TECHNICAL_KNOWLEDGE_BASE}

Banco de plantillas:
${buildTemplatesBlock()}
${buildFrequentResponsesBlock(frequentResponses)}
${regenerateNote}

Cliente: ${buyerName}
Publicación: ${itemLine}
${warrantyLine}
${fullLine}
${shippingStatusLine}

A continuación el hilo de la conversación en orden cronológico. Cuando el cliente adjuntó una
foto o un PDF (factura, constancia fiscal, comprobante...), el archivo viene incluido justo
después de ese mensaje — obsérvalo con atención (una foto puede mostrar la falla, una lectura de
multímetro, una pieza dañada, el empaque, etc.; un PDF puede traer los datos que el cliente ya
mandó para una factura o un comprobante de algo) y úsalo para dar un diagnóstico o respuesta más
precisa, no lo ignores:`;
}

const PROMPT_FOOTER = 'Responde únicamente con el texto de la respuesta sugerida, sin comillas ni explicaciones.';

async function downloadThreadAttachments(messages, token) {
  const refs = [];
  messages.forEach((m, messageIndex) => {
    (m.attachments || []).forEach((att) => refs.push({ messageIndex, att }));
  });
  // Solo bajamos los últimos N adjuntos (fotos o PDFs; los más recientes = más
  // relevantes al problema que sigue sin resolverse), para no disparar el
  // costo/tiempo de Gemini.
  const selected = refs.slice(-MAX_ATTACHMENTS_PER_DRAFT);

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
    if (d.error) return; // si falla la descarga de un adjunto puntual, se omite sin tumbar el borrador
    if (!byMessageIndex.has(d.messageIndex)) byMessageIndex.set(d.messageIndex, []);
    byMessageIndex.get(d.messageIndex).push(d);
  });
  return byMessageIndex;
}

function buildContentParts({ buyerName, itemTitles, messages, orderCreationDate, frequentResponses, previousDraftText, isFull, shippingStatusLabel }, attachmentsByMessageIndex) {
  const parts = [{ text: buildPromptHeader({ buyerName, itemTitles, orderCreationDate, frequentResponses, previousDraftText, isFull, shippingStatusLabel }) }];
  (messages || []).forEach((m, i) => {
    const label = m.sender === 'cliente' ? 'Cliente' : 'Vendedor';
    parts.push({ text: `${label}: ${m.text || '[archivo adjunto]'}` });
    (attachmentsByMessageIndex.get(i) || []).forEach((att) => {
      // Gemini soporta tanto imágenes como PDFs por el mismo inline_data — no hace
      // falta distinguir el tipo aquí, el mime_type ya viene correcto de cada uno.
      parts.push({ inline_data: { mime_type: att.mimeType, data: att.base64 } });
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

// Los modelos 2.5 "piensan" antes de escribir la respuesta visible, y esos tokens de
// razonamiento cuentan contra el MISMO límite de salida — con el presupuesto en 0
// evitábamos por completo el bug viejo de respuestas vacías, pero también evitábamos
// que el modelo razonara sobre conversaciones largas/desordenadas, lo que le hacía
// repetir preguntas ya resueltas o pedir datos que el cliente ya había dado (caso
// real: pedido 2000017949573602). Probado en vivo: con un presupuesto FIJO de 8192
// tokens de "pensamiento" en flash, la calidad de la respuesta se vuelve comparable a
// la de "pro" mientras el costo se mantiene mucho más bajo (Flash sigue cobrando el
// pensamiento a su tarifa de output, ~4x más barata que la de Pro) — y al ser un tope
// fijo (no ilimitado/dinámico), no puede volver a comerse todo el presupuesto de
// salida como en el bug original que motivó ponerlo en 0. "-pro" no acepta
// thinkingBudget en 0 (mínimo 128) y ya piensa por su cuenta, así que esto solo
// aplica a flash/flash-lite.
function buildGenerationConfig() {
  return GEMINI_MODEL.includes('pro') ? undefined : { thinkingConfig: { thinkingBudget: 8192 } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Códigos de error TRANSITORIOS de Gemini — casi siempre se resuelven solos en
// unos segundos (picos de carga del lado de Google, no un problema de nuestro
// prompt ni de la cuenta), así que vale la pena reintentar en vez de tirar el
// borrador a la primera. Caso real: 503 "The service is currently unavailable"
// al darle "Regenerar" a mano (2026-09-03) — sin reintento, cada blip transitorio
// de Gemini obligaba a la persona a volver a darle clic ella misma, y en el botón
// de "Regenerar pendientes" (que corre decenas de borradores seguidos) un solo
// pico de carga podía tirar varios de una vez sin que nadie se enterara cuáles.
const RETRYABLE_GEMINI_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_GEMINI_ATTEMPTS = 3;

// Grounding con Google Search — deja que el modelo consulte información real y
// actual (manuales, foros técnicos, guías del fabricante) en vez de depender
// únicamente de la BASE DE CONOCIMIENTO TÉCNICO fija de abajo. Solo se usa en
// generateDraftAnswer (nunca en las llamadas de extracción/clasificación, que
// necesitan que el modelo se limite a leer la conversación, no a investigar).
const GOOGLE_SEARCH_TOOL = [{ google_search: {} }];

// Una sola llamada a Gemini (con reintento automático ante error transitorio) — no
// lanza error si la respuesta viene vacía o bloqueada, solo lo reporta en el
// resultado (`text` queda vacío). Eso deja que generateDraftAnswer() decida qué
// hacer (reintentar sin imágenes, etc.) en vez de que esta función asuma que un
// texto vacío siempre es un error final.
// `extraGenerationConfig` deja que un llamador puntual (ej. extractStructuredData,
// que necesita JSON confiable, no prosa) agregue campos como `responseMimeType` sin
// afectar a generateDraftAnswer ni duplicar esta función entera.
// `tools` (opcional, 4to argumento) solo lo usa generateDraftAnswer, para dejar
// que Gemini busque en Google además de la BASE DE CONOCIMIENTO TÉCNICO fija de
// arriba (a pedido de Alan, 2026-09-25: diagnósticos técnicos más completos para
// síntomas que esa base no cubre bien) — nunca se manda en las llamadas de
// extracción/clasificación (temperature: 0), donde solo queremos que el modelo
// lea la conversación, no que investigue por su cuenta.
async function callGemini(parts, apiKey, extraGenerationConfig, tools) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const generationConfig = { ...(buildGenerationConfig() || {}), ...(extraGenerationConfig || {}) };

  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
          ...(tools ? { tools } : {}),
        }),
        signal: AbortSignal.timeout(45000),
      }),
      47000,
      'Gemini no respondió a tiempo (timeout)',
    );

    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      // .filter(typeof text === 'string') a propósito: con GOOGLE_SEARCH_TOOL activo,
      // Gemini puede devolver partes sin `.text` (metadatos de la búsqueda) — sin este
      // filtro, un `undefined` ahí se colaría como el string literal "undefined" en la
      // respuesta al unir con join('').
      const text = candidate?.content?.parts?.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').trim();
      return { text, blockReason: data.promptFeedback?.blockReason, finishReason: candidate?.finishReason };
    }

    const body = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${body}`);
    const isLastAttempt = attempt === MAX_GEMINI_ATTEMPTS;
    if (!RETRYABLE_GEMINI_STATUS.has(res.status) || isLastAttempt) throw err;
    // Backoff corto (1.5s, luego 3s) — no vale la pena esperar más: si Gemini
    // sigue caído después de esto, mejor avisar de una vez que dejar a alguien
    // esperando un minuto entero por un borrador.
    await sleep(1500 * attempt);
  }
}

function describeEmptyResult({ blockReason, finishReason }) {
  if (blockReason) return `bloqueó la respuesta por seguridad (${blockReason})`;
  if (finishReason && finishReason !== 'STOP') return `terminó sin texto visible (${finishReason})`;
  return 'no devolvió texto de respuesta';
}

// Red de seguridad DETERMINÍSTICA sobre el texto que devuelve Gemini — no depende de
// que el modelo haya obedecido la regla del prompt (los modelos a veces no la
// respetan). Nace de un caso real donde Gemini inventó un teléfono de "soporte" que
// no existe en ningún lado del sistema. Esto no reemplaza la revisión humana, pero
// deja marcado el borrador para que no pase desapercibido — y es justo el tipo de
// verificación que haría falta como compuerta antes de cualquier envío automático sin
// intervención humana.
const ALLOWED_LINK_DOMAINS = ['marvelsa.com', 'mercadolibre.com.mx', 'mercadolibre.com'];
// Números de 10 dígitos (o 12 con lada +52), con o sin separadores — el formato típico
// de un teléfono mexicano. Ninguna plantilla aprobada incluye un número real de
// contacto (solo piden el del CLIENTE), así que cualquier coincidencia aquí es
// sospechosa por definición.
const PHONE_PATTERN = /(?:\+?52[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g;
const URL_PATTERN = /https?:\/\/[^\s)"']+/gi;

// Límite duro real de Mercado Libre para el texto de un mensaje (ver también el
// "LÍMITE DURO DE MERCADO LIBRE" en el prompt de arriba). Pedírselo a Gemini en el
// prompt no es suficiente por sí solo — sobre todo desde que las causas técnicas
// piden instrucciones completas por causa (no solo el nombre de la pieza), es fácil
// que 2-4 de esas no quepan. Antes, cuando esto pasaba, alguien del equipo tenía que
// editar el borrador a mano antes de poder publicarlo (ver queja real de Getzemany,
// 2026-09-07: "en algunas da más caracteres... no se puede mandar, lo tengo que
// editar"). shortenIfOverLimit() intenta arreglarlo solo con un reintento antes de
// entregar el borrador.
const ML_MAX_CHARS = 350;

async function shortenIfOverLimit(text, apiKey) {
  if (!text || text.length <= ML_MAX_CHARS) return text;
  const prompt = `El siguiente texto es una respuesta para un cliente en Mercado Libre, pero se pasa
del límite de ${ML_MAX_CHARS} caracteres (tiene ${text.length}). Reescríbelo para que quede en
${ML_MAX_CHARS} caracteres o menos, contando espacios. Conserva TODAS las causas/instrucciones
importantes que ya están — prioriza recortar cortesías o explicaciones de más antes que eliminar
una causa completa. No agregues nada nuevo que no estuviera ya en el texto original. Responde
ÚNICAMENTE con el texto ya recortado, sin comillas ni explicación.

Texto original (${text.length} caracteres):
${text}`;
  try {
    const result = await callGemini([{ text: prompt }], apiKey);
    // Si el recorte en sí no vino más corto (o vino vacío), nos quedamos con el
    // original — mejor un borrador largo (se avisa en la UI con el contador en rojo)
    // que uno vacío o que perdió una causa importante sin que nadie lo note.
    if (result.text && result.text.length <= ML_MAX_CHARS) return result.text;
  } catch {
    // Mismo criterio: si el reintento de recorte falla, seguimos con el original.
  }
  return text;
}

function validateDraftText(text) {
  const flags = [];
  if (!text) return flags;

  const phoneMatches = text.match(PHONE_PATTERN) || [];
  const hasSuspiciousPhone = phoneMatches.some((m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length === 10 || digits.length === 12;
  });
  if (hasSuspiciousPhone) flags.push('telefono_no_verificado');

  const urlMatches = text.match(URL_PATTERN) || [];
  const hasUnknownLink = urlMatches.some((url) => !ALLOWED_LINK_DOMAINS.some((domain) => url.includes(domain)));
  if (hasUnknownLink) flags.push('link_no_autorizado');

  return flags;
}

async function generateDraftAnswer({ buyerName, itemTitles, messages, token, orderCreationDate, frequentResponses, previousDraftText, isFull, shippingStatusLabel }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar GEMINI_API_KEY en .env');
  }

  let attachmentsByMessageIndex = new Map();
  if (token) {
    try {
      attachmentsByMessageIndex = await downloadThreadAttachments(messages || [], token);
    } catch {
      // Si algo falla bajando las imágenes en general, seguimos solo con el texto.
      attachmentsByMessageIndex = new Map();
    }
  }

  const draftInput = { buyerName, itemTitles, messages, orderCreationDate, frequentResponses, previousDraftText, isFull, shippingStatusLabel };
  const parts = buildContentParts(draftInput, attachmentsByMessageIndex);
  let result = await callGemini(parts, apiKey, undefined, GOOGLE_SEARCH_TOOL);

  // El bloqueo de seguridad de Gemini casi siempre lo dispara una imagen ambigua (el
  // motivo "OTHER"/"SAFETY" no dice cuál, y no hay forma de saberlo de antemano) —
  // nunca el texto de una conversación de postventa normal. Si hay imágenes de por
  // medio, mejor reintentar una sola vez sin ellas: es preferible entregar un
  // borrador de texto (que alguien revise las fotos a mano) que no entregar nada.
  let imagesExcluded = false;
  if (!result.text && result.blockReason && attachmentsByMessageIndex.size > 0) {
    const textOnlyParts = buildContentParts(draftInput, new Map());
    result = await callGemini(textOnlyParts, apiKey, undefined, GOOGLE_SEARCH_TOOL);
    imagesExcluded = true;
  }

  if (!result.text) {
    // Antes esto siempre decía lo mismo sin importar la causa real — con el motivo
    // exacto es mucho más fácil saber si hace falta ajustar el prompt o si fue un
    // caso raro y aislado.
    throw new Error(`Gemini ${describeEmptyResult(result)}`);
  }

  const finalText = await shortenIfOverLimit(result.text, apiKey);
  const flags = validateDraftText(finalText);
  return { text: finalText, imagesExcluded, flags };
}

// ---------------------------------------------------------------------------------
// Extracción estructurada para la automatización de refacturas y envíos acordados
// (n8n consume esto a través de los endpoints /api/automation/* de server.js — ver
// docs/odoo-refacturas-envios-automation-plan.md). A diferencia de
// generateDraftAnswer (que redacta texto libre para el cliente), acá solo interesa
// un JSON con los datos EXACTOS que el cliente ya escribió — nunca inventar ni
// completar un dato que no esté en el hilo, y nunca contar un dato que dio el
// vendedor como si lo hubiera dado el cliente.
// ---------------------------------------------------------------------------------

const REFACTURA_FIELD_LABELS = {
  razon_social: 'Razón social',
  rfc: 'RFC',
  codigo_postal: 'Código postal fiscal',
  regimen_fiscal: 'Régimen fiscal',
  forma_pago: 'Forma de pago',
  uso_cfdi: 'Uso de CFDI',
};

const ENVIO_ACORDADO_FIELD_LABELS = {
  nombre: 'Nombre',
  direccion_completa: 'Dirección completa (calle, número, colonia, CP, ciudad y estado)',
  referencias_domicilio: 'Referencias de domicilio',
  telefono: 'Teléfono',
};

// A diferencia de generateDraftAnswer, esto sí necesita mirar los adjuntos: la
// plantilla aprobada "Solicitar datos de factura" le pide al cliente su
// Constancia de Situación Fiscal como "PDF o fotografía legible" — muchos clientes
// mandan esa foto en vez de escribir razón social/RFC/código postal fiscal/régimen
// fiscal a mano, y esos datos SÍ están ahí (letra por letra) aunque nunca aparezcan
// en el texto del mensaje. Antes de este fix, extractStructuredData solo miraba
// `m.text`, así que un cliente que hacía exactamente lo que la plantilla pedía
// (mandar la constancia como foto) se quedaba marcado "datos incompletos" para
// siempre — caso real: Emilio Velázquez, 2026-09-25, mandó su constancia completa
// en 3 fotos y el recordatorio le volvió a pedir razón social/RFC/código postal/
// régimen fiscal como si nunca los hubiera dado. Esta función es compartida con
// extractEnvioAcordadoData (mismo riesgo: un cliente puede mandar su nombre/
// dirección/teléfono en una foto en vez de escribirlos), así que el fix aplica
// para las dos por igual, no solo para datos fiscales.
function buildExtractionParts(messages, fieldLabels, attachmentsByMessageIndex) {
  const fieldsList = Object.entries(fieldLabels).map(([key, label]) => `- "${key}": ${label}`).join('\n');
  const header = `Del siguiente hilo de conversación de Mercado Libre, extrae ÚNICAMENTE estos datos, y
ÚNICAMENTE si el CLIENTE los proporcionó explícitamente — ya sea escribiéndolos en un mensaje, O
dentro de una foto/PDF que el cliente adjuntó. Revisa esas imágenes con atención, letra por letra:
un cliente puede mandar, por ejemplo, una foto de su Constancia de Situación Fiscal del SAT (con
razón social, RFC, código postal fiscal y régimen fiscal ya impresos) o una foto/captura con su
nombre, dirección y teléfono (una etiqueta de paquete, una identificación, un mapa, etc.) — nunca
asumas que un dato falta solo porque el cliente no lo escribió a mano, si aparece en una imagen
cuenta igual. Nunca cuentes un dato que haya escrito o adjuntado el vendedor, y nunca lo inventes
ni lo completes por suposición o contexto:
${fieldsList}

Responde ÚNICAMENTE con un JSON (sin explicación, sin markdown) con exactamente estas claves:
${Object.keys(fieldLabels).map((k) => `"${k}"`).join(', ')}.
Cada valor debe ser el texto exacto (transcrito tal cual si viene de una imagen), o \`null\` si el
cliente no dio ese dato específico en ningún mensaje ni adjunto del hilo.

A continuación el hilo de la conversación en orden cronológico. Cuando el cliente adjuntó una foto
o un PDF, el archivo viene incluido justo después de ese mensaje:`;

  const parts = [{ text: header }];
  (messages || []).forEach((m, i) => {
    const label = m.sender === 'cliente' ? 'Cliente' : 'Vendedor';
    parts.push({ text: `${label}: ${m.text || '[archivo adjunto]'}` });
    (attachmentsByMessageIndex.get(i) || []).forEach((att) => {
      parts.push({ inline_data: { mime_type: att.mimeType, data: att.base64 } });
    });
  });
  return parts;
}

// Devuelve { complete, data, missing }: `complete` es true solo si TODOS los campos
// pedidos vinieron con un valor no vacío — con un solo campo faltante, la
// automatización de n8n no debe avanzar (mismo criterio que hoy: la compañera de
// Ecommerce no planifica en Odoo con datos fiscales incompletos).
async function extractStructuredData(messages, fieldLabels, token, apiKey) {
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en .env');

  let attachmentsByMessageIndex = new Map();
  if (token) {
    try {
      attachmentsByMessageIndex = await downloadThreadAttachments(messages || [], token);
    } catch {
      // Si falla la descarga en general, seguimos solo con el texto en vez de
      // tumbar la extracción completa.
      attachmentsByMessageIndex = new Map();
    }
  }

  let result;
  try {
    // temperature: 0 a propósito (a pedido de Alan, 2026-09-25, para reducir el
    // margen de error de las automatizaciones): esto es extracción de datos, no
    // redacción creativa — queremos la respuesta más consistente posible entre una
    // corrida y otra, no variedad.
    result = await callGemini(buildExtractionParts(messages, fieldLabels, attachmentsByMessageIndex), apiKey, {
      responseMimeType: 'application/json',
      temperature: 0,
    });
  } catch {
    // Un hilo que por ahora no se puede analizar (Gemini caído, timeout, etc.) se
    // trata igual que "incompleto" — n8n simplemente lo vuelve a intentar en la
    // siguiente corrida, en vez de que el endpoint entero falle por un solo pack.
    return { complete: false, data: {}, missing: Object.keys(fieldLabels) };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text || '');
  } catch {
    return { complete: false, data: {}, missing: Object.keys(fieldLabels) };
  }

  const data = {};
  const missing = [];
  for (const key of Object.keys(fieldLabels)) {
    const value = typeof parsed[key] === 'string' ? parsed[key].trim() : null;
    if (value) data[key] = value; else missing.push(key);
  }
  return { complete: missing.length === 0, data, missing };
}

function extractRefacturaData(messages, token, apiKey) {
  return extractStructuredData(messages, REFACTURA_FIELD_LABELS, token, apiKey);
}

function extractEnvioAcordadoData(messages, token, apiKey) {
  return extractStructuredData(messages, ENVIO_ACORDADO_FIELD_LABELS, token, apiKey);
}

// ---------------------------------------------------------------------------------
// Detección de "el cliente está pidiendo factura por primera vez en este hilo" —
// para la automatización de primer contacto de refacturas en server.js
// (sendFacturaFirstContactForRecord). A diferencia de REFACTURA_ASK_PATTERNS (un
// regex simple que solo detecta si el VENDEDOR ya pidió los datos fiscales), aquí
// hace falta juzgar la intención real del CLIENTE en su último mensaje: un regex
// sobre la palabra "factura" también dispararía con negaciones ("no necesito
// factura"), agradecimientos de una factura ya recibida, o preguntas de estatus de
// una ya pedida — nada de eso es "pedirla por primera vez". Se usa Gemini para
// juzgar la intención en contexto, igual que extractStructuredData ya hace arriba.
function buildFacturaIntentPrompt(messages) {
  const thread = (messages || [])
    .map((m) => {
      const attachmentNote = m.hasAttachment ? ' [+ archivo/foto adjunto]' : '';
      return `${m.sender === 'cliente' ? 'Cliente' : 'Vendedor'}: ${m.text || '[archivo adjunto]'}${attachmentNote}`;
    })
    .join('\n');
  return `Del siguiente hilo de conversación de Mercado Libre, decide si el CLIENTE está pidiendo
POR PRIMERA VEZ en este hilo que se le facture o refacture su compra (quiere que le emitan un
CFDI/factura fiscal de este pedido) con un mensaje SIMPLE, SIN mandar ya ningún dato.

Responde que SÍ únicamente si se cumplen las dos cosas:
1. El cliente está solicitando activamente una factura o refactura (ej. "me pueden facturar",
   "necesito facturar", "¿aplica factura?").
2. Ese mismo mensaje (o cualquier mensaje anterior del cliente en el hilo) NO incluye ya ningún
   dato fiscal ni archivo — nada de RFC, razón social, dirección fiscal, código postal fiscal,
   régimen fiscal, uso de CFDI, forma de pago, correo, ni ninguna foto/PDF adjunto (marcado como
   "[+ archivo/foto adjunto]" en el hilo de abajo). Si el cliente ya mandó cualquiera de esos datos
   junto con su petición (aunque sea uno solo, o venga en el mismo mensaje), responde que NO — esos
   casos los revisa una persona a mano, no se contestan con la plantilla genérica.

Responde que NO en cualquier otro caso, incluyendo (sin limitarse a):
- El cliente dice que NO quiere factura, o que ya no la necesita.
- El cliente ya pidió factura antes en este mismo hilo (revisa TODO el hilo, no solo el último
  mensaje) — si ya la pidió una vez, no es "primera vez" aunque insista o dé seguimiento.
- El cliente pregunta por el estatus de una factura que ya pidió, o agradece una que ya recibió.
- El cliente menciona la palabra "factura" de pasada, sin pedir activamente que se la emitan.
- El cliente ya mandó algún dato fiscal o adjuntó algo (ver punto 2 de arriba).

Responde ÚNICAMENTE con un JSON (sin explicación, sin markdown) con esta forma exacta:
{"pide_factura_primera_vez": true} o {"pide_factura_primera_vez": false}

Hilo de la conversación (orden cronológico):
${thread}`;
}

// Si Gemini falla (caído, timeout, respuesta no parseable), se trata como "no" —
// el peor caso es que este pedido puntual no recibe el auto-contacto y sigue su
// curso normal por el borrador de IA con revisión humana, nunca al revés.
async function detectsFirstFacturaRequest(messages, apiKey) {
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en .env');
  let result;
  try {
    // temperature: 0 a propósito — clasificación, no redacción; queremos la misma
    // respuesta cada vez que se evalúe el mismo hilo, no variedad entre corridas.
    result = await callGemini([{ text: buildFacturaIntentPrompt(messages) }], apiKey, {
      responseMimeType: 'application/json',
      temperature: 0,
    });
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(result.text || '');
    return parsed.pide_factura_primera_vez === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------
// Clasificación para el primer contacto combinado de "Acordar con el vendedor" (a
// pedido de Alan, 2026-09-24): esta automatización manda SIEMPRE la plantilla de
// envío gratis en estos pedidos apenas el vendedor no le ha contestado nada al
// cliente todavía — pero si el cliente YA escribió algo antes de que corriera la
// automatización (la "opción 2" del problema de la carrera con el sync), hay que
// decidir qué tanto se puede seguir mandando en automático sin ignorar lo que el
// cliente ya dijo:
// - Si no dijo nada más que un saludo genérico (o de plano no ha escrito nada): se
//   manda solo la plantilla de envío, igual que siempre.
// - Si además pidió factura, pero sin dar NINGÚN dato todavía (ni de envío ni
//   fiscal, ni adjuntó nada): se mandan las DOS plantillas (envío y factura), cada
//   una pidiendo sus datos — sigue siendo seguro porque no hay ningún dato que
//   repetir o ignorar.
// - Cualquier otro caso (ya dio algún dato, o pregunta algo más allá de envío/
//   factura) se abstiene por completo y lo deja pasar a revisión humana — mandar
//   una plantilla fija ahí repetiría datos ya dados o ignoraría lo que preguntó,
//   el mismo error que ya se evitó para la automatización de factura sola.
function buildAgreedShippingFirstContactPrompt(messages) {
  const thread = (messages || [])
    .map((m) => {
      const attachmentNote = m.hasAttachment ? ' [+ archivo/foto adjunto]' : '';
      return `${m.sender === 'cliente' ? 'Cliente' : 'Vendedor'}: ${m.text || '[archivo adjunto]'}${attachmentNote}`;
    })
    .join('\n');
  return `Este es un pedido de Mercado Libre de tipo "Acordar con el vendedor" (sin logística de
Mercado Libre, el envío es gratis y se coordina directo). El VENDEDOR todavía NO le ha contestado
nada al cliente. El hilo de abajo son únicamente mensajes del cliente (puede ser uno, varios, o
ninguno si el cliente tampoco ha escrito todavía).

Clasifica la situación en EXACTAMENTE una de estas tres categorías:

"solo_envio": el cliente no está pidiendo activamente una factura/refactura (no escribió nada, o
lo que escribió no menciona pedirla, o la menciona solo de pasada sin pedirla activamente). Es la
categoría normal/por default.

"envio_y_factura": el cliente SÍ está pidiendo activamente que se le facture su compra (ej. "me
pueden facturar", "necesito mi factura", "¿aplica factura?"), Y ADEMÁS no ha dado ningún dato
concreto todavía — ni de envío (nombre, dirección, teléfono, referencias de domicilio) ni de
factura (RFC, razón social, dirección fiscal, código postal fiscal, régimen fiscal, uso de CFDI,
forma de pago, correo), ni adjuntó ninguna foto/PDF (marcado como "[+ archivo/foto adjunto]" en el
hilo). Es un mensaje simple pidiendo ambas cosas, sin datos todavía.

"abstenerse": cualquier otro caso, incluyendo (sin limitarse a):
- El cliente ya dio cualquier dato concreto (de envío O de factura), o adjuntó algo — aunque sea
  un solo dato suelto. No importa si pidió factura o no: si ya hay CUALQUIER dato, es "abstenerse".
- El cliente pregunta o reporta algo más allá de simplemente pedir envío/factura (una falla del
  producto, una queja, garantía, cancelar el pedido, etc.).
- Cualquier caso ambiguo donde no estés seguro.

Responde ÚNICAMENTE con un JSON (sin explicación, sin markdown) con esta forma exacta:
{"categoria": "solo_envio"} o {"categoria": "envio_y_factura"} o {"categoria": "abstenerse"}

Mensajes del cliente en este hilo (orden cronológico; puede estar vacío):
${thread || '(el cliente no ha escrito nada todavía)'}`;
}

const AGREED_SHIPPING_FIRST_CONTACT_CATEGORIES = new Set(['solo_envio', 'envio_y_factura', 'abstenerse']);

// Si Gemini falla o responde algo no reconocido, se trata como "abstenerse" — el
// peor caso es que este pedido puntual no recibe el auto-contacto y sigue su curso
// normal por el borrador de IA con revisión humana, nunca al revés.
async function classifyAgreedShippingFirstContact(messages, apiKey) {
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en .env');
  if (!messages || messages.length === 0) return 'solo_envio'; // nadie ha escrito nada — atajo barato, sin llamar a Gemini
  let result;
  try {
    // temperature: 0 a propósito — clasificación, no redacción; queremos la misma
    // respuesta cada vez que se evalúe el mismo hilo, no variedad entre corridas.
    result = await callGemini([{ text: buildAgreedShippingFirstContactPrompt(messages) }], apiKey, {
      responseMimeType: 'application/json',
      temperature: 0,
    });
  } catch {
    return 'abstenerse';
  }
  try {
    const parsed = JSON.parse(result.text || '');
    return AGREED_SHIPPING_FIRST_CONTACT_CATEGORIES.has(parsed.categoria) ? parsed.categoria : 'abstenerse';
  } catch {
    return 'abstenerse';
  }
}

module.exports = {
  generateDraftAnswer,
  validateDraftText,
  extractRefacturaData,
  extractEnvioAcordadoData,
  detectsFirstFacturaRequest,
  classifyAgreedShippingFirstContact,
  REFACTURA_FIELD_LABELS,
  ENVIO_ACORDADO_FIELD_LABELS,
};

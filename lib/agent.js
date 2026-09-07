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
equipo/motor y por síntoma específico) como tu fuente principal de diagnóstico, no solo lo que
sepas de forma genérica.

LÍMITE DURO DE MERCADO LIBRE: cada respuesta que redactes desde cero (sin plantilla aplicable)
debe tener COMO MÁXIMO 350 caracteres en total, contando espacios. Mercado Libre no permite
mensajes más largos. Esto es innegociable, incluso si eso significa acortar explicaciones.

Formato: cuando redactes una respuesta nueva (sin plantilla aplicable):
- Para fallas técnicas o "no enciende/no funciona": saludo muy breve + 2 a 4 causas/soluciones,
  cada una como una instrucción corta que el cliente pueda seguir sin saber de mecánica — no basta
  con nombrar la pieza. Mal: "switch en ON", "choke en RUN al arrancar". Bien: "revisa que el
  switch esté en ON", "coloca el choke en RUN antes de arrancar". Numeradas o en lista, + cierre
  de una línea pidiendo confirmar si así enciende. Todo debe caber en 350 caracteres — si no
  alcanza para las 4 causas con instrucciones claras, prioriza menos causas bien explicadas por
  encima de más causas dichas solo con el nombre de la pieza.
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

function buildPromptHeader({ buyerName, itemTitles, orderCreationDate, frequentResponses, previousDraftText, isFull }) {
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

Si la pregunta es sobre GARANTÍA: usa el dato "Días desde la compra" de abajo para decidir entre
la plantilla "Garantía dentro de 30 días" (si son 30 días o menos) o "Garantía fuera de 30 días"
(si son más de 30) — nunca lo adivines por el tono del cliente, usa el número exacto.

Si el cliente YA describió una falla técnica concreta (no solo preguntó de garantía en general),
ninguna de las dos plantillas de garantía basta por sí sola tal cual — las dos solo prometen
"orientación técnica" o preguntan qué falla presenta, sin dar ninguna instrucción real, dejando al
cliente sin respuesta a lo que preguntó. En ese caso: usa la plantilla de garantía como apertura,
pero reemplaza la frase de "orientación técnica"/"qué falla presenta" por 2 causas/instrucciones
reales para esa falla (mismo formato breve y accionable de la sección de fallas técnicas), dentro
de los 350 caracteres. Caso real: cliente dijo que la desbrozadora "no gira al acelerar" y la
plantilla de garantía vencida se mandó tal cual, sin decirle qué revisar.

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

Si el caso es de ENVÍO GRATIS / pedir datos de domicilio: revisa con cuidado todo el hilo antes de
elegir la plantilla, porque hay tres momentos distintos y usar la equivocada confunde al cliente:
- Si el cliente TODAVÍA no ha escrito su nombre, dirección completa y teléfono en ningún mensaje
  anterior del hilo: usa "Solicitud de datos para envío gratis" (pidiendo esos datos).
- Si el cliente YA escribió esos datos completos en un mensaje anterior (aunque sea el mensaje
  más reciente): usa "Después de compartir datos de envío" para confirmar y avisar que el envío
  ya se está gestionando. NUNCA vuelvas a listar, repetir o citar los datos que el cliente ya dio
  — eso ya se recibió, pedirlo de nuevo o repetírselo es un error grave, no una simple molestia.
- Si el cliente dio los datos pero de forma incompleta (falta algún dato de la lista): usa
  "Mensaje recordatorio de datos pendientes".

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

function buildContentParts({ buyerName, itemTitles, messages, orderCreationDate, frequentResponses, previousDraftText, isFull }, attachmentsByMessageIndex) {
  const parts = [{ text: buildPromptHeader({ buyerName, itemTitles, orderCreationDate, frequentResponses, previousDraftText, isFull }) }];
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

// Una sola llamada a Gemini (con reintento automático ante error transitorio) — no
// lanza error si la respuesta viene vacía o bloqueada, solo lo reporta en el
// resultado (`text` queda vacío). Eso deja que generateDraftAnswer() decida qué
// hacer (reintentar sin imágenes, etc.) en vez de que esta función asuma que un
// texto vacío siempre es un error final.
async function callGemini(parts, apiKey) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          ...(buildGenerationConfig() ? { generationConfig: buildGenerationConfig() } : {}),
        }),
        signal: AbortSignal.timeout(45000),
      }),
      47000,
      'Gemini no respondió a tiempo (timeout)',
    );

    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text).join('').trim();
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

async function generateDraftAnswer({ buyerName, itemTitles, messages, token, orderCreationDate, frequentResponses, previousDraftText, isFull }) {
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

  const draftInput = { buyerName, itemTitles, messages, orderCreationDate, frequentResponses, previousDraftText, isFull };
  const parts = buildContentParts(draftInput, attachmentsByMessageIndex);
  let result = await callGemini(parts, apiKey);

  // El bloqueo de seguridad de Gemini casi siempre lo dispara una imagen ambigua (el
  // motivo "OTHER"/"SAFETY" no dice cuál, y no hay forma de saberlo de antemano) —
  // nunca el texto de una conversación de postventa normal. Si hay imágenes de por
  // medio, mejor reintentar una sola vez sin ellas: es preferible entregar un
  // borrador de texto (que alguien revise las fotos a mano) que no entregar nada.
  let imagesExcluded = false;
  if (!result.text && result.blockReason && attachmentsByMessageIndex.size > 0) {
    const textOnlyParts = buildContentParts(draftInput, new Map());
    result = await callGemini(textOnlyParts, apiKey);
    imagesExcluded = true;
  }

  if (!result.text) {
    // Antes esto siempre decía lo mismo sin importar la causa real — con el motivo
    // exacto es mucho más fácil saber si hace falta ajustar el prompt o si fue un
    // caso raro y aislado.
    throw new Error(`Gemini ${describeEmptyResult(result)}`);
  }

  const flags = validateDraftText(result.text);
  return { text: result.text, imagesExcluded, flags };
}

module.exports = { generateDraftAnswer, validateDraftText };

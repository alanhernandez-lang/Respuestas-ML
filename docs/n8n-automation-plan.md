# Plan de automatización con n8n (borrador, en pausa)

Estado: **En pausa** — a la espera de que Alan confirme con la persona con la que
lleva trabajando el tema de ML cómo va a arrancar la automatización (reunión
agendada para la semana del 24 de agosto de 2026). Este documento es la base de
diseño para retomar la conversación en ese momento, no una decisión final.

## 1. Objetivo

Que el agente de IA pueda contestar directamente a los clientes de Mercado Libre
sin que un humano tenga que revisar cada respuesta antes de publicarla — orquestado
desde n8n en vez de solo generar un borrador dentro de esta app.

## 2. Alcance del auto-envío: filtro de confianza (recomendado, no "todo de una")

En vez de automatizar todos los casos desde el día uno, empezar con una compuerta
de confianza. Solo se auto-publica si se cumplen TODAS estas condiciones:

- La respuesta usa una plantilla aprobada tal cual (banco de plantillas de
  `lib/agent.js`), no una redacción libre.
- `validateDraftText()` no marcó ninguna alerta (teléfono/link sospechoso — ver
  `lib/agent.js`).
- La conversación no está en mediación, ni es especialmente larga/enredada.

Todo lo que no cumpla esto sigue yendo a revisión humana, igual que hoy. La idea es
ir aflojando el filtro con el tiempo conforme se validen resultados reales, no
apostarlo todo de entrada.

Motivo: en la sesión del 19 de agosto de 2026 se encontraron y corrigieron 3 bugs
reales de la IA en un solo día (un teléfono inventado, dos veces repitiendo datos
que el cliente ya había dado) — ningún modelo se puede dar por infalible, el filtro
es la red de seguridad mientras se conoce el comportamiento real en producción.

## 3. Arquitectura: n8n como orquestador, NO como reemplazo de la lógica ya probada

Recomendación clave: **no reescribir en nodos de n8n** la lógica de
`server.js`/`lib/ml.js` (paginación de la API de Mercado Libre, refresco de token
OAuth, resolución de mediaciones/Full/estatus de envío, subida de adjuntos, etc.).
Esa lógica ya tiene meses de bugs reales corregidos uno por uno.

En su lugar:
- El Node app (hoy en Render, `respuestas-ml.onrender.com`) se queda corriendo como
  "motor" — expone por API lo que ya hace (traer mensajes, generar borrador con
  Gemini, consultar el banco de respuestas, publicar una respuesta).
- n8n orquesta CUÁNDO se llama cada cosa, aplica el filtro de confianza de la
  sección 2, decide auto-publicar o mandar a cola de revisión humana, y corre el
  pipeline nuevo de facturas (sección 4).
- La interfaz que usa el equipo hoy puede quedar reducida a un panel de solo
  lectura (bitácora, banco de respuestas, mediaciones) en vez de la app completa de
  gestión de borradores — pero el motor de datos/Redis no se tira.

## 4. Pipeline nuevo: extracción de datos de factura (PDFs/fotos → Sheet)

Cuando un cliente manda un PDF o foto con sus datos para facturar (constancia de
situación fiscal, etc.), automatizar:
1. Detectar el adjunto relevante en la conversación (ya existe la descarga de
   adjuntos vía `fetchAttachment` en `lib/ml.js`).
2. Usar Gemini (visión) para extraer en un formato fijo: RFC, razón social, uso de
   CFDI, forma de pago, código postal fiscal, etc.
3. Agregar una fila a un Google Sheet con esos datos, para automatizar el flujo de
   facturación.

Falta definir: el esquema exacto de columnas del Sheet, y qué pasa si la extracción
sale incompleta/dudosa (¿se manda a revisión humana o se pide de nuevo al cliente?).

## 5. Mediaciones: visibilidad, nunca auto-respuesta

Una mediación es el proceso formal de disputa de Mercado Libre — el intercambio
real ocurre en el Centro de Resoluciones de ML, no por mensajes normales. Por eso:

- **Nunca se auto-responde** una conversación en mediación, sin importar qué tan
  automatizado esté el resto (la app hoy ya bloquea el chat normal en este caso,
  ver `resolveMediation()` en `server.js`).
- Sí debe quedar **visible** para el equipo: se propone (a) un aviso activo (Slack,
  WhatsApp, correo — el que ya usen) en cuanto una conversación entra o sale de
  mediación, con el tipo de caso y un link directo, y (b) mantener un panel donde
  se pueda consultar el historial completo (activas + ya cerradas, como el badge
  "Tuvo mediación" que ya existe hoy).

## 6. Bloqueante actual

No hay una conexión de n8n autorizada en las herramientas de Claude todavía — sin
eso, solo se puede dejar el diseño en papel, no crear/probar workflows reales.
Cuando se retome, hay que autorizar el conector de n8n desde la configuración de
claude.ai para poder construir directamente.

## 7. Pendiente de decidir en la reunión de la próxima semana

- Confirmar (o ajustar) el filtro de confianza de la sección 2.
- Confirmar la arquitectura de la sección 3 (¿de acuerdo en no reescribir la lógica
  ya probada dentro de n8n?).
- Definir el esquema del Sheet de facturación y el manejo de casos dudosos.
- Definir por dónde se manda el aviso de mediaciones (Slack/WhatsApp/correo/otro).

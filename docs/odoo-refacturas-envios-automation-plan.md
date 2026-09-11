# Automatizar refacturas y envíos acordados (Odoo + n8n)

Estado: **Aprobado (2026-09-10)** — el gerente de Alan aprobó la propuesta de
alcance angosto de la sección 3 (solo automatizar la planificación mecánica,
sin tocar las validaciones humanas de Crédito y Cobranza / Tráfico). Ya existe:

- Los endpoints de automatización en la app (ver sección 5).
- Un borrador de workflow de n8n listo para importar:
  [docs/n8n/refacturas-envios-acordados.workflow.json](n8n/refacturas-envios-acordados.workflow.json).

**Todavía falta antes de poder activarlo de verdad** (ver checklist de la
sección 4, ítems 2-4): un usuario/API key dedicado de Odoo, y confirmar con
quien administra Odoo los nombres técnicos exactos de los campos (sobre todo
cómo se busca la cotización a partir del número de pedido de Mercado Libre).
Mientras tanto, el workflow crea una Actividad de Odoo (`mail.activity`) sobre
la cotización en vez de escribir campos personalizados — eso no depende de esa
confirmación pendiente.

## 1. Los dos procesos, tal como los explicó Alan

### Refacturas

1. Se le piden al cliente 6 datos: razón social, RFC, código postal, régimen
   fiscal, forma de pago, uso de CFDI.
2. Una compañera de Ecommerce hace una "planificación" en Odoo (Ventas →
   Cotizaciones, en el número de orden) con esos datos.
3. Se pasa a Crédito y Cobranza, que **valida los datos a mano** y procede con la
   factura.
4. Si el cliente tiene correo registrado, Odoo manda la factura solo; si no, hay
   que bajarla y subirla a mano por el chat de Mercado Libre.

### Envíos acordados con el comprador

1. Se le piden al cliente 4 datos: nombre, dirección completa (calle, número,
   colonia, CP, ciudad, estado), referencias de domicilio, teléfono.
2. Se hace una planificación y esos datos quedan en el campo "Comentarios" del
   pedido en Odoo.
3. **Tráfico (Angel Samuel Gonzalez Vargas y compañeros) valida A MANO** si el
   envío a esa dirección es viable/accesible.
4. Si es viable, se llenan "Transportista" y "Referencia de rastreo" en el
   movimiento de stock del pedido.
5. Alguien copia esos dos datos a mano y se los manda al cliente por el chat de
   Mercado Libre (mismo formato que ya usa el agente de IA para esto).

## 2. Por qué el gerente dijo "aún no": las validaciones humanas SÍ importan

- La validación de Crédito y Cobranza sobre los datos fiscales, y la validación
  de Tráfico sobre si el envío es viable, **son decisiones de negocio reales**,
  no pasos mecánicos — automatizarlas de verdad sería el riesgo real que
  preocupa. Cualquier propuesta que las mantenga intactas reduce mucho ese
  riesgo.

## 3. Propuesta refinada de Alan (2026-09-03) — alcance más angosto

En vez de automatizar el proceso completo, automatizar solo los dos extremos
mecánicos de cada proceso, dejando las validaciones humanas exactamente igual
que hoy:

### Refacturas

- **Automatizar la planificación**: en cuanto el cliente da los 6 datos
  fiscales en el chat, n8n los mete solo a la cotización en Odoo (hoy lo hace a
  mano la compañera de Ecommerce). Crédito y Cobranza sigue validando igual que
  hoy antes de generar la factura — eso NO se toca.
- **Nueva sección en la app de Mensajes ML**: una vista de "refacturas
  pendientes" para que el equipo vea en qué parte del proceso va cada una
  (¿ya se planificó? ¿ya la validó Crédito y Cobranza? ¿ya se facturó?). Esto
  requiere que la app también LEA de Odoo (no solo que n8n escriba hacia allá)
  — es una integración aparte de la que usaría n8n para escribir.
- **Envío automático del resultado**: hoy, si el cliente tiene correo
  registrado, Odoo YA manda la factura sola (esto no es nuevo ni hay que
  tocarlo). Lo manual hoy es solo el caso SIN correo: alguien baja el PDF y lo
  sube a mano al chat de ML. Automatizar eso es: detectar en Odoo que la
  factura ya se generó/validó, bajar el PDF, y subirlo como adjunto al chat de
  ML — la app ya sabe adjuntar PDFs al chat (se usa para lo que manda el
  cliente), así que esa pieza es reutilizable.

### Envíos acordados

- Mismo patrón: automatizar la planificación (meter los 4 datos de envío del
  chat a Odoo) y el envío automático del resultado al cliente en cuanto Tráfico
  llene Transportista + Referencia de rastreo — sin tocar la validación de
  Tráfico sobre si el envío es viable.
- Esta pieza (mandar transportista + número de guía) sigue siendo la más segura
  de las dos: es texto 100% mecánico, sin generación libre de IA de por medio.

## 4. Checklist para cuando se autorice

### Depende de gestión/accesos (Alan)

1. Luz verde del gerente sobre este alcance más angosto (no el proceso
   completo).
2. Un usuario/API key **dedicado** de Odoo para la automatización — NO las
   credenciales personales de la compañera de Ecommerce. Si cambia su
   contraseña o deja el puesto, la automatización se rompe sin aviso, y
   cualquier acción quedaría atribuida a su usuario personal en el historial de
   Odoo. Pedir a quien administra el Odoo de Marvelsa un usuario aparte.
3. Permisos de ese usuario: LECTURA sobre pedidos/envíos/facturas para la parte
   de "mandar el resultado" y la sección de visibilidad; ESCRITURA sobre la
   cotización solo para la parte de "meter los datos del chat a Odoo".
4. Confirmar con quien administra Odoo los nombres técnicos exactos de los
   campos que se van a leer/escribir (Transportista, Referencia de rastreo, los
   6 campos fiscales, estatus de la factura) — los nombres en pantalla no son
   los nombres técnicos que usa la API.

### Trabajo técnico (una vez con los accesos)

5. Endpoint nuevo en la app de Mensajes ML, protegido con un secreto (mismo
   patrón que ya usa el cron de sincronización), para que n8n pueda decirle
   "manda este texto/adjunto a este pedido" sin que haga falta una sesión de
   usuario iniciada — el mensaje es mecánico (guía, o factura adjunta), no algo
   que redacte el agente de IA.
6. Confirmar que el número de pedido en Odoo (`ML 2000018249490300`) siempre
   coincide exactamente con el pedido en la app de Mensajes ML
   (`Pedido 2000018249490300`) — por las capturas que compartió Alan sí
   coincide, pero conviene confirmarlo con un par de casos reales antes de
   automatizar sobre esa suposición.
7. Endpoint(s) de lectura para la sección de "pendientes" en la app (refacturas
   y envíos), que consulten el estatus real en Odoo.
8. Definir cómo dispara n8n cada paso: lo más simple es que revise Odoo cada
   cierto tiempo (igual que nuestro propio cron cada 2 minutos con Mercado
   Libre); la alternativa (que Odoo avise solo con una Acción Automatizada) es
   más rápida pero requiere que alguien la configure dentro de Odoo.
9. Probar primero con 1-2 pedidos reales de cada proceso antes de dejarlo
   corriendo solo, igual que con cada cosa nueva de esta app.

## 5. Lo que ya está construido (2026-09-10)

Cubre el ítem 5 del checklist (la parte de "leer del chat", no la de "mandar el
resultado" — esa sigue pendiente, es una fase aparte):

- **`lib/agent.js`**: `extractRefacturaData(messages, apiKey)` y
  `extractEnvioAcordadoData(messages, apiKey)` — le piden a Gemini (con
  `responseMimeType: application/json`) que extraiga los 6/4 datos SOLO si el
  cliente los escribió explícitamente en el hilo (nunca inventa ni completa por
  contexto). Devuelven `{ complete, data, missing }` — `complete` es `false` si
  falta aunque sea un solo dato.
- **`server.js`** — 3 endpoints nuevos, protegidos con el mismo `CRON_SECRET`
  que ya usa el cron de sincronización (mismo patrón, sin variable de entorno
  nueva):
  - `GET /api/automation/refacturas-pendientes`
  - `GET /api/automation/envios-acordados-pendientes`
  - `POST /api/automation/marcar-planificado` (body `{ packId, categoria,
    odooActivityId }`) — n8n lo llama después de crear la Actividad en Odoo,
    para que ese pack no se vuelva a ofrecer en la siguiente corrida. El estado
    "ya planificado" vive en Redis (`app:automation:planned`), no en el propio
    pack, así que sobrevive a un re-sync normal.
  - Antes de gastar una llamada a Gemini por pack, hay un prefiltro barato
    (`REFACTURA_ASK_PATTERNS` / `ENVIO_ACORDADO_ASK_PATTERNS` en `server.js`)
    que solo analiza los packs donde el VENDEDOR ya pidió esos datos (detecta
    frases de las plantillas ya aprobadas) — si la redacción de esas plantillas
    cambia, hay que revisar estos patrones.
- **`docs/n8n/refacturas-envios-acordados.workflow.json`**: workflow de n8n
  listo para importar (`Import from File` / pegar el JSON), con las dos ramas
  (refacturas y envíos acordados) sobre un mismo Schedule Trigger cada 10
  minutos. Trae notas adhesivas (sticky notes) con lo que falta confirmar antes
  de activarlo — ver el nodo "LÉEME ANTES DE ACTIVAR" al importarlo.

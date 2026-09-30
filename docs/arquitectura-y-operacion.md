# Arquitectura y operación (estado real, 2026-09-21)

Este documento describe cómo funciona la app **tal como está hoy en producción**,
no el plan original. Sirve como el entregable de "documentación del workflow" /
"documentación operacional" de las tareas de ClickUp
[3. Desarrollo del Agente Automatizado](https://app.clickup.com/t/86e2bu6j7) y
[5. Deployment en Producción](https://app.clickup.com/t/86e2bu6t1).

## 1. Stack y dónde vive cada cosa

| Pieza | Qué es |
|---|---|
| Backend | Node.js + Express, un solo proceso (`server.js` + `lib/agent.js`, `lib/ml.js`, `lib/auth.js`, `lib/redis.js`) |
| Frontend | HTML/JS estático en `public/` (`app.js`), servido por el mismo Express |
| IA | Google Gemini (`GEMINI_API_KEY` / `GEMINI_MODEL` en variables de entorno) |
| Base de datos | Redis nativo en Coolify vía `ioredis` (ver `docs/redis-migration.md`) — usuarios/sesión, caché de mensajes/packs, bitácora, contador de respuestas, presencia en vivo, estado de automatizaciones |
| Origen de mensajes | Polling a la API de Mercado Libre cada `SYNC_INTERVAL_MS` (2 min por defecto), no webhook |
| Deploy | Coolify (`sistemas411/ai-apps`, carpeta `mensajes-post-venta-ml`, dominio `mensajes-post-venta-ml.coolify.marvelsa.com`). Antes Vercel (migrado por límite de ancho de banda del plan gratis) y luego Render — `render.yaml`/`vercel.json` quedan en el repo como reliquia, ya no se usan |
| Orquestación de automatizaciones | **Ninguna herramienta externa.** Todo vive dentro de esta misma app (ver sección 4) — N8N fue descartado por completo |

## 2. Flujo de un mensaje, end-to-end

1. **Sync** (`server.js`, cada `SYNC_INTERVAL_MS`): trae mensajes nuevos de la API de
   Mercado Libre, resuelve nombre de cliente/publicación (con caché en
   `data/messages-cache.json` vía Redis), estado exacto de envío
   (`resolveShippingInfo`) y si hay mediación abierta (`resolveMediation` — si la
   hay, esa conversación queda bloqueada para respuesta normal).
2. **Borrador con IA** (`lib/agent.js`): Gemini lee la conversación completa, hasta
   las últimas 4 fotos adjuntas, y los datos exactos de envío, y sugiere una
   respuesta usando el banco de ~15 plantillas aprobadas por categoría (Factura,
   Acordadas con el comprador, Aceite, Garantías y reclamos, Otros).
3. **Revisión humana** (pestaña "Borradores IA" en la UI): una persona del equipo ve
   el borrador, lo puede editar, pedir "Regenerar", o hacer clic en **"Publicar ↗"**.
4. **Publicación real** (`POST /api/messages/:packId/publish` → `publishAnswerInner`,
   `server.js:1006`): esto **sí llama a la API de Mercado Libre** (`sendPackMessage`)
   y manda el mensaje real al comprador — no es una simulación ni solo copiar/pegar.
   Requiere que un humano lo dispare; el agente nunca publica por su cuenta excepto
   el caso mecánico de la sección 4.
5. **Registro**: cada envío (manual o automático) queda en la bitácora
   (`appendAnswerLog`) y sube el contador de respuestas de quien lo mandó.

> Nota: el README todavía decía "el agente nunca publica nada en Mercado Libre,
> solo la copias" — eso quedó desactualizado desde que existe el botón Publicar y
> se corrige en este documento y en el README.

## 3. Mediaciones

Una mediación (disputa formal de ML) **nunca se auto-responde**, sin excepción —
`resolveMediation()` bloquea el chat normal en ese caso. El equipo la ve marcada
con el badge "Tuvo mediación".

## 4. Automatizaciones activas (sin N8N)

### 4.1 Recordatorio mecánico de datos faltantes (activa, detrás de flag)

- Vive en el propio ciclo de sync cada 2 minutos (`sendAutomationReminders`,
  `server.js:1644`), no en una herramienta externa.
- Si el vendedor ya pidió datos de refactura o de envío acordado (detectado por
  patrones de texto sobre las plantillas aprobadas —
  `REFACTURA_ASK_PATTERNS` / `ENVIO_ACORDADO_ASK_PATTERNS`) y el cliente contestó
  incompleto, manda un recordatorio **sin revisión humana** — decisión explícita de
  Alan (2026-09-10), aceptable porque el texto es 100% mecánico (plantilla aprobada
  o lista exacta de campos faltantes, nunca redacción libre de la IA).
- Apagada por default: solo corre si `AUTOMATION_REMINDERS_ENABLED=true` está
  puesto en las variables de entorno de producción.
- Estado de "ya recordado" vive en Redis (`app:automation:reminded`), por pregunta
  del cliente, para no insistir con el mismo mensaje.

### 4.2 Refacturas y envíos acordados hacia Odoo (endpoints listos, orquestador pendiente)

- Endpoints ya construidos y protegidos con `CRON_SECRET`
  (`checkAutomationSecret`, `server.js:1671`):
  - `GET /api/automation/refacturas-pendientes`
  - `GET /api/automation/envios-acordados-pendientes`
  - `POST /api/automation/marcar-planificado`
- Usan `extractRefacturaData` / `extractEnvioAcordadoData` (`lib/agent.js`) para
  sacar los datos exactos que el cliente ya escribió (nunca inventa), con un
  prefiltro barato antes de gastar una llamada a Gemini.
- Estado de "ya planificado" vive en Redis (`app:automation:planned`).
- **Pendiente:** algo que llame a estos endpoints periódicamente y escriba en Odoo.
  El plan original usaba n8n para esto — ya no. Se va a implementar como un
  scheduler interno dentro de esta misma app (mismo patrón que el sync de ML cada 2
  min), una vez estén el usuario/API key dedicado de Odoo y los nombres técnicos de
  campo confirmados (ver `docs/odoo-refacturas-envios-automation-plan.md`).

## 5. Variables de entorno relevantes en producción

| Variable | Para qué |
|---|---|
| `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REFRESH_TOKEN` | Credenciales de la app de Mercado Libre |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Generación de borradores |
| `CRON_SECRET` | Autentica los endpoints de automatización (`/api/automation/*`) sin sesión de usuario |
| `AUTOMATION_REMINDERS_ENABLED` | Apaga/prende el recordatorio automático de la sección 4.1 (default: apagado) |
| Redis (Coolify) | Ver `docs/redis-migration.md` para las variables de conexión |

## 6. Operación básica / troubleshooting

- **Ver si la app está corriendo:** panel de Coolify → proyecto MVS → `mensajes-post-venta-ml` (estado "Running", healthcheck, logs de runtime/deploy ahí mismo).
- **Ver actividad reciente:** bitácora interna de la app (cada respuesta enviada,
  manual o automática, con quién la mandó).
- **Si dejan de llegar mensajes nuevos:** revisar que el token de Mercado Libre
  siga vigente — se refresca solo y se guarda en `data/token-store.json`, pero si
  falla el refresh hay que revisar los Runtime Logs de la app en Coolify.
- **Si Redis falla:** ver `docs/redis-migration.md` — hay un mecanismo de
  migración desde Upstash (`lib/legacyUpstash.js`) que solo debería correr una vez;
  si Redis está vacío por error, no debería volver a jalar datos viejos de Upstash
  a menos que ese archivo siga activo.

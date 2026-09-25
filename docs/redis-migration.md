# Migración de Redis: Upstash → Redis propio en Coolify

**Fecha:** 2026-09-04 (branch `redis-coolify-migration`).

## Por qué

Upstash (plan gratuito, usado vía `@upstash/redis` con REST API) llegó al 90% de
su cupo de comandos/mes en solo 3 días de uso real de la app. Pagar por ese
volumen no tenía sentido pudiendo usar un Redis normal en el mismo servidor de
Coolify donde ya corre la app (sin costo extra). Cuando Upstash termina de
agotar su cupo, cualquier lectura a Redis falla — incluida `verifyCredentials`
en [lib/auth.js](../lib/auth.js), que revisa el hash `app:users` en cada login.
Eso se manifiesta como **"Correo o contraseña incorrectos" para cualquier
usuario**, aunque los datos sean correctos.

## Qué cambió

- [lib/redis.js](../lib/redis.js) pasó de `@upstash/redis` (REST API) a
  `ioredis` hablando el protocolo nativo contra `REDIS_URL` (el Redis que
  Coolify crea y configura al levantar la base).
- `ioredis` no serializa/deserializa automáticamente como sí hacía
  `@upstash/redis`. El wrapper `redis` en ese mismo archivo (`encode`/`decode`)
  replica ese comportamiento a mano para que el resto del código (server.js,
  lib/ml.js, lib/auth.js) no tuviera que cambiar.
- [lib/legacyUpstash.js](../lib/legacyUpstash.js): cliente de Upstash que se
  usa **solo** para la migración única de datos (ver abajo). Usa
  `KV_REST_API_URL` / `KV_REST_API_TOKEN`, las mismas variables que Coolify ya
  tenía configuradas de cuando la app corría contra Upstash.
- `migrateFromUpstashIfEmpty()` en [server.js](../server.js): corre una sola
  vez al arrancar el servidor. Si el Redis nuevo de Coolify ya tiene datos en
  `app:users`, no hace nada (evita duplicar/pisar en cada restart). Si está
  vacío y hay credenciales de Upstash disponibles, copia `app:users` (el más
  crítico — sin él nadie puede loguear), `app:answercounts`, `app:answerlog`,
  `ml:token`, `ml:cache:meta`, `ml:cache:packs` y `app:lastSyncError`.

## Variables de entorno necesarias en Coolify

| Variable | Para qué | Se puede borrar después de migrar |
|---|---|---|
| `REDIS_URL` | Redis nuevo (Coolify), destino de todo a partir de ahora | No |
| `KV_REST_API_URL` | Redis viejo (Upstash), origen de la migración única | Sí, una vez confirmada la migración |
| `KV_REST_API_TOKEN` | Idem | Sí, una vez confirmada la migración |

Si `KV_REST_API_URL`/`KV_REST_API_TOKEN` no están configuradas al desplegar
esta branch, la migración se salta silenciosamente (solo deja un
`console.warn`) y el Redis nuevo arranca vacío — **nadie va a poder loguear**
hasta que se agregue algún usuario a mano con
`node scripts/manage-users.js add correo@ejemplo.com "contraseña"` apuntando
al `REDIS_URL` nuevo.

## Limpieza pendiente (una vez confirmada la migración en producción)

- Borrar [lib/legacyUpstash.js](../lib/legacyUpstash.js).
- Borrar la llamada a `migrateFromUpstashIfEmpty()` en `server.js` (o dejarla,
  es inofensiva mientras el Redis nuevo ya tenga datos — pero es código muerto).
- Sacar la dependencia `@upstash/redis` de `package.json`.
- Borrar `KV_REST_API_URL` / `KV_REST_API_TOKEN` de Coolify.

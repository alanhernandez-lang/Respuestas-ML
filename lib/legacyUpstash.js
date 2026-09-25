const { Redis } = require('@upstash/redis');

// SOLO para la migración única de Upstash al Redis de Coolify (2026-09-04, ver
// REDIS_URL y lib/redis.js). Usa las variables KV_REST_API_URL/KV_REST_API_TOKEN
// que Coolify todavía tiene configuradas de cuando la app corría contra Upstash.
// Una vez confirmada la migración (ver migrateFromUpstashIfEmpty en server.js), se
// puede borrar este archivo, la dependencia @upstash/redis del package.json, y esas
// dos variables de entorno.
function legacyUpstashClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = { legacyUpstashClient };

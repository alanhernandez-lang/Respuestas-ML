const IORedis = require('ioredis');

// 2026-09-04: migrado de Upstash (API REST, @upstash/redis) a un Redis normal
// corriendo en el propio servidor de Coolify — Upstash llegó al 90% de su cupo
// gratuito de comandos/mes en solo 3 días (el volumen real de esta app ya superó
// lo que el plan gratuito soporta), y pagar por ese volumen no tenía sentido
// pudiendo usar un Redis en el mismo servidor que ya se paga. REDIS_URL la
// configuró Coolify al crear la base (ver docs/redis-migration si se documenta).
const client = new IORedis(process.env.REDIS_URL);

client.on('error', (err) => console.error('[redis] error de conexión:', err.message));

// Upstash (@upstash/redis) auto-serializaba cualquier valor que NO fuera string
// (JSON.stringify antes de mandarlo) y, al leer, intentaba JSON.parse cualquier
// string que devolviera — con eso, todo el código existente asume que `redis.get`/
// `redis.hget` pueden devolver un objeto/número directo (ej. lib/ml.js espera un
// objeto de `redis.get(TOKEN_KEY)` sin parsear nada) Y que un string que no es JSON
// válido (ej. "salt:hash" en app:users) se devuelve tal cual. ioredis habla el
// protocolo nativo de Redis, que solo maneja strings — replicamos aquí ambos lados
// de ese comportamiento para que el resto del código (server.js, lib/ml.js,
// lib/auth.js) no tenga que cambiar ni una línea.
function encode(value) {
  if (value === null || value === undefined) return value;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function decode(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value; // no era JSON válido (ej. "salt:hash") — se devuelve tal cual
  }
}

function decodeHash(obj) {
  if (!obj) return obj;
  const out = {};
  for (const [field, value] of Object.entries(obj)) out[field] = decode(value);
  return out;
}

const redis = {
  get: async (key) => decode(await client.get(key)),
  set: (key, value) => client.set(key, encode(value)),
  del: (key) => client.del(key),
  hget: async (key, field) => decode(await client.hget(key, field)),
  hgetall: async (key) => decodeHash(await client.hgetall(key)),
  hincrby: (key, field, increment) => client.hincrby(key, field, increment),
  hset: (key, fieldsObj) => {
    const encoded = {};
    for (const [field, value] of Object.entries(fieldsObj)) encoded[field] = encode(value);
    return client.hset(key, encoded);
  },
  // HSCAN nativo — mismo motivo que en los scripts de corrección de datos de esta
  // temporada: HGETALL sobre un hash grande puede violar límites de tamaño de
  // request en algunos backends, y de todos modos aquí es más barato para el
  // caso de uso de migración (leer en lotes). cursor es string ('0' para empezar).
  hscan: async (key, cursor, ...args) => {
    const [nextCursor, flat] = await client.hscan(key, cursor, ...args);
    const fields = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = decode(flat[i + 1]);
    return [nextCursor, fields];
  },
  lpush: (key, value) => client.lpush(key, encode(value)),
  rpush: (key, value) => client.rpush(key, encode(value)),
  ltrim: (key, start, stop) => client.ltrim(key, start, stop),
  lrange: async (key, start, stop) => (await client.lrange(key, start, stop)).map(decode),
};

// Reemplaza al mutex en memoria (`cacheQueue`) que usábamos con el disco local: en
// serverless puede haber varias instancias corriendo a la vez, así que el lock tiene
// que vivir en un lugar compartido (Redis), no en una variable de proceso.
// `SET clave 1 NX PX <ms>` solo escribe si la clave no existe todavía (NX) y expira
// sola a los `ttlMs` (PX) — así un lock nunca queda pegado para siempre si el proceso
// que lo tomó se cae a medias.
async function acquireLock(key, ttlMs) {
  const result = await client.set(key, '1', 'PX', ttlMs, 'NX');
  return result === 'OK';
}

async function releaseLock(key) {
  await redis.del(key);
}

// Ejecuta `fn` solo si logra tomar el lock; si no, avisa que ya hay algo corriendo
// (equivalente al 409 "Ya hay una sincronización en curso" que ya teníamos).
async function withLock(key, ttlMs, fn) {
  const acquired = await acquireLock(key, ttlMs);
  if (!acquired) {
    const err = new Error('Ya hay una operación en curso, intenta en unos segundos');
    err.status = 409;
    throw err;
  }
  try {
    return await fn();
  } finally {
    await releaseLock(key);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A diferencia de `withLock` (que falla de inmediato si el lock está tomado), esta
// variante ESPERA a que se libere reintentando cada poco — pensada para el refresh
// del token de Mercado Libre: si dos llamadas necesitan un token al mismo tiempo, la
// segunda debe usar el token que ya refrescó la primera, no fallar con un error.
async function withLockRetry(key, ttlMs, maxWaitMs, fn) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const acquired = await acquireLock(key, ttlMs);
    if (acquired) {
      try {
        return await fn();
      } finally {
        await releaseLock(key);
      }
    }
    await sleep(300);
  }
  throw new Error(`No se pudo obtener el lock "${key}" a tiempo`);
}

module.exports = { redis, acquireLock, releaseLock, withLock, withLockRetry };

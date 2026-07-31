const { Redis } = require('@upstash/redis');

// Upstash inyecta estas variables automáticamente al conectar la integración desde
// el Marketplace de Vercel. En local, se toman del .env (ver README).
const redis = Redis.fromEnv();

// Reemplaza al mutex en memoria (`cacheQueue`) que usábamos con el disco local: en
// serverless puede haber varias instancias corriendo a la vez, así que el lock tiene
// que vivir en un lugar compartido (Redis), no en una variable de proceso.
// `SET clave 1 NX PX <ms>` solo escribe si la clave no existe todavía (NX) y expira
// sola a los `ttlMs` (PX) — así un lock nunca queda pegado para siempre si el proceso
// que lo tomó se cae a medias.
async function acquireLock(key, ttlMs) {
  const result = await redis.set(key, '1', { nx: true, px: ttlMs });
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

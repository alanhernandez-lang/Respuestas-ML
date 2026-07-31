// Script de una sola vez: importa data/messages-cache.json y data/token-store.json
// (el estado local acumulado antes de migrar a Vercel) hacia Redis, para no perder
// las conversaciones ya sincronizadas.
//
// Uso:
//   1. Poner en .env las credenciales REALES de Upstash (UPSTASH_REDIS_REST_URL /
//      UPSTASH_REDIS_REST_TOKEN), las mismas que va a usar la app en producción.
//   2. node scripts/import-to-redis.js
//
// Es seguro correrlo más de una vez: simplemente sobreescribe las mismas claves.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { redis } = require('../lib/redis');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'messages-cache.json');
const TOKEN_PATH = path.join(__dirname, '..', 'data', 'token-store.json');

async function main() {
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    await redis.set('ml:token', token);
    console.log('Token importado (expira:', new Date(token.expires_at).toISOString(), ')');
  } else {
    console.log('No se encontró data/token-store.json, se omite (la app pedirá uno nuevo con ML_REFRESH_TOKEN).');
  }

  if (!fs.existsSync(CACHE_PATH)) {
    console.log('No se encontró data/messages-cache.json, nada que importar.');
    return;
  }

  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const packIds = Object.keys(cache.packs || {});
  console.log(`Importando ${packIds.length} conversaciones...`);

  // HSET acepta muchos campos a la vez, pero con ~400 packs y mensajes con imágenes
  // en base64 el payload total puede ser grande: lo partimos en lotes chicos para no
  // pegarle a límites de tamaño de request de Upstash.
  const BATCH_SIZE = 25;
  for (let i = 0; i < packIds.length; i += BATCH_SIZE) {
    const batchIds = packIds.slice(i, i + BATCH_SIZE);
    const fields = {};
    batchIds.forEach((id) => { fields[id] = cache.packs[id]; });
    await redis.hset('ml:cache:packs', fields);
    console.log(`  ${Math.min(i + BATCH_SIZE, packIds.length)}/${packIds.length}`);
  }

  await redis.set('ml:cache:meta', { syncedAt: cache.syncedAt });
  console.log('Listo. syncedAt importado:', cache.syncedAt);
}

main().catch((err) => {
  console.error('Error importando a Redis:', err);
  process.exit(1);
});

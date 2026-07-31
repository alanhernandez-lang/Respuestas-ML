const crypto = require('crypto');
const { redis } = require('./redis');

const SESSION_COOKIE = 'ml_session';
// Es una herramienta interna de uso diario: 30 días evita que el equipo tenga que
// volver a iniciar sesión seguido, sin dejar de expirar en algún momento.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Hash de las cuentas permitidas: correo -> "salt:hash" (scrypt). Vive en Redis
// (no en un env var) para poder agregar/quitar gente sin tocar código ni redeploy.
const USERS_KEY = 'app:users';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function matchesHash(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  // Comparación en tiempo constante para no filtrar el hash por temporización.
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function verifyCredentials(email, password) {
  const normalized = (email || '').trim().toLowerCase();
  const stored = normalized ? await redis.hget(USERS_KEY, normalized) : null;
  if (!stored || !matchesHash(password || '', stored)) {
    const err = new Error('Correo o contraseña incorrectos');
    err.status = 401;
    throw err;
  }
  return normalized;
}

function sign(data) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(data).digest('base64url');
}

function createSessionToken(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.email;
  } catch {
    return null;
  }
}

module.exports = {
  SESSION_COOKIE,
  USERS_KEY,
  hashPassword,
  verifyCredentials,
  createSessionToken,
  verifySessionToken,
};

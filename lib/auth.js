const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const SESSION_COOKIE = 'ml_session';
// Es una herramienta interna de uso diario: 30 días evita que el equipo tenga que
// volver a iniciar sesión seguido, sin dejar de expirar en algún momento.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function getAllowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function verifyGoogleCredential(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) {
    const err = new Error('El correo de Google no está verificado');
    err.status = 401;
    throw err;
  }
  const email = payload.email.toLowerCase();
  if (!getAllowedEmails().includes(email)) {
    const err = new Error('Este correo no tiene acceso a la aplicación');
    err.status = 403;
    throw err;
  }
  return email;
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
  // Comparación en tiempo constante: evita que un atacante deduzca la firma correcta
  // midiendo cuánto tarda la comparación byte a byte.
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

module.exports = { SESSION_COOKIE, verifyGoogleCredential, createSessionToken, verifySessionToken };

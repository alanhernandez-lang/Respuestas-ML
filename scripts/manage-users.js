// Administra quién puede iniciar sesión en la app (guardado en Redis, hash `app:users`).
//
// Uso (con las credenciales reales de Upstash en .env o en la línea de comando):
//   node scripts/manage-users.js add correo@ejemplo.com "una-contraseña"
//   node scripts/manage-users.js remove correo@ejemplo.com
//   node scripts/manage-users.js list

require('dotenv').config();
const { redis } = require('../lib/redis');
const { USERS_KEY, hashPassword } = require('../lib/auth');

async function main() {
  const [, , action, email, password] = process.argv;

  if (action === 'add') {
    if (!email || !password) {
      console.log('Uso: node scripts/manage-users.js add correo@ejemplo.com "contraseña"');
      process.exit(1);
    }
    const normalized = email.trim().toLowerCase();
    await redis.hset(USERS_KEY, { [normalized]: hashPassword(password) });
    console.log(`Usuario agregado/actualizado: ${normalized}`);
  } else if (action === 'remove') {
    if (!email) {
      console.log('Uso: node scripts/manage-users.js remove correo@ejemplo.com');
      process.exit(1);
    }
    await redis.hdel(USERS_KEY, email.trim().toLowerCase());
    console.log(`Usuario eliminado: ${email.trim().toLowerCase()}`);
  } else if (action === 'list') {
    const users = await redis.hgetall(USERS_KEY);
    const emails = Object.keys(users || {});
    console.log(emails.length ? emails.join('\n') : '(sin usuarios registrados)');
  } else {
    console.log('Uso: node scripts/manage-users.js <add|remove|list> [correo] ["contraseña"]');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error administrando usuarios:', err);
  process.exit(1);
});

'use strict';
/** Reset (or create) the admin password. Usage: node scripts/reset-admin.js [username] [password] */
const { db } = require('../src/core/db');
const { hashPassword, randomId } = require('../src/core/crypto');

const username = process.argv[2] || 'admin';
const password = process.argv[3] || randomId(9);

const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(existing.id);
  console.log(`Parol yangilandi → ${username} / ${password}`);
} else {
  db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)').run(username, hashPassword(password), 'owner');
  console.log(`Admin yaratildi → ${username} / ${password}`);
}
db.close();

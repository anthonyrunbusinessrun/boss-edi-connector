const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'correct horse battery staple';
process.env.SESSION_SECRET = '12345678901234567890123456789012';
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/services/session')];
const { createSession, verifySession, verifyPassword } = require('../src/services/session');

test('admin password comparison is exact', () => {
  assert.equal(verifyPassword('correct horse battery staple'), true);
  assert.equal(verifyPassword('wrong'), false);
});

test('signed sessions validate and reject tampering', () => {
  const token = createSession();
  assert.equal(verifySession(token), true);
  assert.equal(verifySession(`${token}x`), false);
});

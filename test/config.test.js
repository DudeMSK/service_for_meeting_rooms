const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ConfigStore,
  normalizeServer,
  normalizeSettings,
  splitMailboxes,
  validateSettings,
} = require('../src/main/config');

test('normalizeServer accepts a hostname or EWS URL', () => {
  assert.equal(normalizeServer('https://mail.example.org/EWS/Exchange.asmx'), 'mail.example.org');
  assert.equal(normalizeServer('mail.example.org/'), 'mail.example.org');
});

test('splitMailboxes trims, lowercases and removes duplicates', () => {
  assert.deepEqual(splitMailboxes(' User@Example.org,other@example.org;user@example.org '), [
    'user@example.org',
    'other@example.org',
  ]);
});

test('normalizeSettings applies safe defaults, limits refresh interval and migrates legacy appearance', () => {
  const config = normalizeSettings({
    email: 'SERVICE@EXAMPLE.ORG',
    username: 'DOMAIN\\service',
    password: 'secret',
    server: 'mail.example.org',
    mailboxes: ['ROOM@EXAMPLE.ORG'],
    refreshMinutes: 100,
    theme: 'dark',
    accent: 'violet',
  });
  assert.equal(config.email, 'service@example.org');
  assert.equal(config.refreshMinutes, 60);
  assert.equal(config.auth, 'ntlm');
  assert.equal(config.mainTheme, 'dark');
  assert.equal(config.mainAccent, 'violet');
  assert.equal(config.sidebarTheme, 'dark');
  assert.equal(config.sidebarAccent, 'violet');
  assert.deepEqual(config.mailboxes, ['room@example.org']);
  assert.deepEqual(validateSettings(config), []);
});

test('normalizeSettings keeps main content and sidebar appearance independent', () => {
  const config = normalizeSettings({
    mainTheme: 'light',
    mainAccent: 'orange',
    sidebarTheme: 'match-main',
    sidebarAccent: 'blue',
  });
  assert.equal(config.mainTheme, 'light');
  assert.equal(config.mainAccent, 'orange');
  assert.equal(config.sidebarTheme, 'match-main');
  assert.equal(config.sidebarAccent, 'blue');
});

test('validateSettings reports all required connection fields', () => {
  const errors = validateSettings(normalizeSettings({}));
  assert.equal(errors.length, 5);
});

test('saving user-visible settings preserves hidden EWS credentials and mailboxes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-room-config-'));
  const appPath = path.join(root, 'app');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(appPath);
  fs.writeFileSync(path.join(appPath, '.env'), [
    'EWS_EMAIL=service@example.org',
    'EWS_USERNAME=DOMAIN\\service',
    'EWS_PASSWORD=test-secret',
    'EWS_SERVER=mail.example.org',
    'EWS_MAILBOXES=one@example.org',
  ].join('\n'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8'),
  };
  try {
    const store = new ConfigStore({ appPath, userDataPath, safeStorage });
    store.save({
      refreshMinutes: 10,
      timeZone: 'Europe/Moscow',
      mainTheme: 'dark',
      mainAccent: 'blue',
      sidebarTheme: 'light',
      sidebarAccent: 'orange',
    });
    const saved = store.load();
    assert.equal(saved.server, 'mail.example.org');
    assert.equal(saved.email, 'service@example.org');
    assert.equal(saved.username, 'DOMAIN\\service');
    assert.equal(saved.password, 'test-secret');
    assert.deepEqual(saved.mailboxes, ['one@example.org']);
    assert.equal(saved.refreshMinutes, 10);
    assert.equal(saved.mainTheme, 'dark');
    assert.equal(saved.mainAccent, 'blue');
    assert.equal(saved.sidebarTheme, 'light');
    assert.equal(saved.sidebarAccent, 'orange');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update token from .env round-trips through encrypted storage and is never exposed in publicConfig', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-room-config-'));
  const appPath = path.join(root, 'app');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(appPath);
  fs.writeFileSync(path.join(appPath, '.env'), [
    'EWS_EMAIL=service@example.org',
    'EWS_USERNAME=DOMAIN\\service',
    'EWS_PASSWORD=test-secret',
    'EWS_SERVER=mail.example.org',
    'EWS_MAILBOXES=one@example.org',
    'GH_TOKEN=initial-token',
  ].join('\n'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8'),
  };
  try {
    const store = new ConfigStore({ appPath, userDataPath, safeStorage });
    const publicResult = store.save({ refreshMinutes: 10, timeZone: 'Europe/Moscow' });
    assert.equal(publicResult.updateToken, undefined);
    assert.equal(store.load().updateToken, 'initial-token');

    // Saving again without providing an update token must not wipe the stored one.
    store.save({ refreshMinutes: 12 });
    assert.equal(store.load().updateToken, 'initial-token');

    const stored = JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'));
    assert.ok(stored.updateTokenEncrypted);
    assert.equal(stored.updateToken, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

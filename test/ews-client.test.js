const test = require('node:test');
const assert = require('node:assert/strict');
const { bodyToText, deduplicateEvents, safeError } = require('../src/main/ews-client');

test('bodyToText reads EWS MessageBody values used to find Teams links', () => {
  assert.equal(bodyToText({ Text: 'https://teams.live.com/meet/123' }), 'https://teams.live.com/meet/123');
  assert.equal(bodyToText(null), '');
});

test('deduplicateEvents merges the same meeting from several delegated calendars', () => {
  const base = {
    id: 'one',
    uid: 'ical-uid',
    subject: 'Совещание',
    start: '2026-09-11T09:00:00.000Z',
    end: '2026-09-11T10:00:00.000Z',
    location: 'Переговорная 1',
    cancelled: false,
    sourceMailboxes: ['one@example.org'],
  };
  const result = deduplicateEvents([
    base,
    { ...base, id: 'two', sourceMailboxes: ['two@example.org'] },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sourceMailboxes, ['one@example.org', 'two@example.org']);
});

test('deduplicateEvents drops cancelled and invalid occurrences', () => {
  const result = deduplicateEvents([
    { uid: 'one', start: null, end: null, location: '', cancelled: false, sourceMailboxes: [] },
    { uid: 'two', start: '2026-09-11T09:00:00Z', end: '2026-09-11T10:00:00Z', location: '', cancelled: true, sourceMailboxes: [] },
  ]);
  assert.deepEqual(result, []);
});

test('safeError translates the NTLM transport-failure TypeError into a network message', () => {
  const config = { password: 'secret', username: 'user' };
  const error = new TypeError("Cannot read properties of undefined (reading 'headers')");
  assert.equal(
    safeError(error, config),
    'Нет соединения с сервером Exchange: сервер не ответил на запрос авторизации NTLM. Проверьте сеть/VPN и адрес сервера, затем повторите попытку.',
  );
});

test('safeError translates common low-level network error codes', () => {
  const config = { password: 'secret', username: 'user' };
  const error = new Error('connect ECONNREFUSED 10.0.0.1:443');
  assert.equal(safeError(error, config), 'Нет соединения с сервером Exchange. Проверьте сеть/VPN и адрес сервера.');
});

test('safeError still masks the password and username in unrecognized errors', () => {
  const config = { password: 'secret', username: 'user' };
  const error = new Error('Unexpected failure for user with secret');
  assert.equal(safeError(error, config), 'Unexpected failure for *** with ***');
});

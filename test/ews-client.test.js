const test = require('node:test');
const assert = require('node:assert/strict');
const { deduplicateEvents } = require('../src/main/ews-client');

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

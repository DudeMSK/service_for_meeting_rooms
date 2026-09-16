const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FirefliesApi,
  FirefliesMonitor,
  buildMeetingTitle,
  cleanMeetingLink,
  extractMeetingLink,
  meetingKey,
  normalizeStoredMeetingKey,
} = require('../src/main/fireflies-service');

test('extractMeetingLink supports corporate and personal Teams URLs in body and HTML entities', () => {
  assert.equal(
    cleanMeetingLink('join https://teams.microsoft.com/l/meetup-join/abc?x=1&amp;y=2'),
    'https://teams.microsoft.com/l/meetup-join/abc?x=1&y=2',
  );
  assert.equal(
    extractMeetingLink({ body: '<a href="https://teams.live.com/meet/123?p=secret">join</a>' }),
    'https://teams.live.com/meet/123?p=secret',
  );
  assert.equal(extractMeetingLink({ location: 'Офис (Москва)' }), '');
});

test('legacy Python meeting keys are normalized to the same UTC key', () => {
  assert.equal(
    normalizeStoredMeetingKey('https://teams.live.com/meet/123::2026-09-15T09:00:00+03:00'),
    'https://teams.live.com/meet/123::2026-09-15T06:00:00.000Z',
  );
});

test('buildMeetingTitle keeps the legacy room and local date format', () => {
  assert.equal(
    buildMeetingTitle({ subject: 'Планёрка', location: 'ЭРС Групп Магадан (2 этаж)', start: '2026-09-15T06:00:00Z' }, 'Europe/Moscow'),
    'Планёрка - Магадан - (15.09.2026 - 09:00)',
  );
});

test('FirefliesApi sends the documented addToLiveMeeting payload and clamps duration', async () => {
  let request;
  const api = new FirefliesApi({
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: { addToLiveMeeting: { success: true } } }) };
    },
  });
  await api.addToLiveMeeting('secret-key', { link: 'https://teams.live.com/meet/123', title: 'Встреча', durationMinutes: 4 });
  assert.equal(request.variables.meetingLink, 'https://teams.live.com/meet/123');
  assert.equal(request.variables.duration, 15);
  assert.match(request.query, /addToLiveMeeting/);
});

test('monitor dispatches one deduplicated meeting and persists verification state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fireflies-monitor-'));
  const statePath = path.join(root, 'state.json');
  const now = new Date('2026-09-15T06:00:00.000Z');
  const calls = [];
  const config = {
    firefliesEnabled: true,
    firefliesApiKey: 'secret-key',
    firefliesPollSeconds: 60,
    firefliesJoinLeadMinutes: 1,
    firefliesVerifyDelayMinutes: 5,
    firefliesVerifyMaxAttempts: 3,
    firefliesVerifyRetryMinutes: 5,
    timeZone: 'Europe/Moscow',
  };
  const event = {
    subject: 'Планёрка',
    start: '2026-09-15T06:00:30.000Z',
    end: '2026-09-15T07:00:30.000Z',
    location: 'ЭРС Групп Москва (2 этаж)',
    body: 'https://teams.microsoft.com/l/meetup-join/abc',
    cancelled: false,
  };
  const monitor = new FirefliesMonitor({
    configStore: { load: () => config },
    createEwsClient: () => ({ getBridgeEvents: async () => [event, { ...event }] }),
    statePath,
    now: () => new Date(now),
    api: {
      addToLiveMeeting: async (_apiKey, input) => calls.push(input),
      hasTranscript: async () => false,
      testConnection: async () => ({ ok: true }),
    },
  });
  try {
    const status = await monitor.runNow();
    assert.equal(calls.length, 1);
    assert.equal(status.mode, 'running');
    assert.equal(status.processedCount, 1);
    assert.equal(status.pendingCount, 1);
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(Object.keys(stored.processed).length, 1);
    assert.equal(stored.pending.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

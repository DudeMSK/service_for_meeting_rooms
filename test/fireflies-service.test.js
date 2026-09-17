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
  computeBackoffUntil,
  extractMeetingLink,
  isRateLimitError,
  meetingKey,
  normalizeStoredMeetingKey,
  parseRetryAfter,
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

test('isRateLimitError recognizes rate-limit phrasing and ignores unrelated errors', () => {
  assert.equal(isRateLimitError(new Error('Too many requests. Please retry after Tue, 15 Sep 2026 16:19:34 GMT (UTC)')), true);
  assert.equal(isRateLimitError(new Error('Rate limit exceeded')), true);
  assert.equal(isRateLimitError(new Error('Invalid API key')), false);
  assert.equal(isRateLimitError(), false);
});

test('parseRetryAfter extracts and parses the GMT retry hint from an error message', () => {
  const date = parseRetryAfter('Too many requests. Please retry after Tue, 15 Sep 2026 16:19:34 GMT (UTC)');
  assert.equal(date.toISOString(), '2026-09-15T16:19:34.000Z');
  assert.equal(parseRetryAfter('Too many requests, no hint here'), null);
});

test('computeBackoffUntil prefers a valid retry-after hint plus a safety margin over exponential backoff', () => {
  const now = new Date('2026-09-15T16:00:00.000Z');
  const until = computeBackoffUntil({
    error: new Error('Too many requests. Please retry after Tue, 15 Sep 2026 16:19:34 GMT (UTC)'),
    now,
    consecutiveHits: 1,
  });
  assert.equal(until.toISOString(), '2026-09-15T16:20:04.000Z');
});

test('computeBackoffUntil falls back to a capped exponential backoff without a usable hint', () => {
  const now = new Date('2026-09-15T16:00:00.000Z');
  const first = computeBackoffUntil({ error: new Error('Too many requests'), now, consecutiveHits: 1 });
  assert.equal(first.getTime() - now.getTime(), 5 * 60 * 1000);
  const fourth = computeBackoffUntil({ error: new Error('Too many requests'), now, consecutiveHits: 4 });
  assert.equal(fourth.getTime() - now.getTime(), 40 * 60 * 1000);
  const capped = computeBackoffUntil({ error: new Error('Too many requests'), now, consecutiveHits: 10 });
  assert.equal(capped.getTime() - now.getTime(), 60 * 60 * 1000);
});

test('monitor enters rate-limit backoff after a failed send, skips the rest of the batch, and short-circuits until the window passes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fireflies-ratelimit-'));
  const statePath = path.join(root, 'state.json');
  let now = new Date('2026-09-15T06:00:00.000Z');
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
  const firstEvent = {
    subject: 'Планёрка',
    start: '2026-09-15T06:00:30.000Z',
    end: '2026-09-15T07:00:30.000Z',
    location: 'ЭРС Групп Москва (2 этаж)',
    body: 'https://teams.microsoft.com/l/meetup-join/first',
    cancelled: false,
  };
  const secondEvent = {
    subject: 'Совещание',
    start: '2026-09-15T06:00:45.000Z',
    end: '2026-09-15T07:00:45.000Z',
    location: 'ЭРС Групп Магадан (2 этаж)',
    body: 'https://teams.microsoft.com/l/meetup-join/second',
    cancelled: false,
  };
  const monitor = new FirefliesMonitor({
    configStore: { load: () => config },
    createEwsClient: () => ({ getBridgeEvents: async () => [firstEvent, secondEvent] }),
    statePath,
    now: () => new Date(now),
    api: {
      addToLiveMeeting: async (_apiKey, input) => {
        calls.push(input);
        throw new Error('Too many requests. Please retry after Tue, 15 Sep 2026 06:20:00 GMT (UTC)');
      },
      hasTranscript: async () => false,
      testConnection: async () => ({ ok: true }),
    },
  });
  try {
    const status = await monitor.runNow();
    assert.equal(calls.length, 1, 'the second event in the same batch must not be attempted once a rate limit hits');
    assert.equal(status.mode, 'rate-limited');
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(Object.keys(stored.processed).length, 0);
    assert.ok(stored.rateLimitedUntil);
    assert.equal(new Date(stored.rateLimitedUntil).toISOString(), '2026-09-15T06:20:30.000Z');

    const secondStatus = await monitor.runNow();
    assert.equal(calls.length, 1, 'no further API calls should be made while backoff is active');
    assert.equal(secondStatus.mode, 'rate-limited');

    await assert.rejects(() => monitor.testApi(), /ограничил частоту запросов/);

    now = new Date('2026-09-15T06:21:00.000Z');
    const thirdStatus = await monitor.runNow();
    assert.equal(calls.length, 2, 'once the backoff window passes the monitor should try again');
    assert.equal(thirdStatus.mode, 'rate-limited');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

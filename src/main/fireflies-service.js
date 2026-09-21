const fs = require('node:fs');

const FIREFLIES_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';
const MAX_LOG_ENTRIES = 200;
const MAX_PROCESSED_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const LOCAL_RATE_LIMIT_WINDOW_MS = 20 * 60 * 1000;
const LOCAL_RATE_LIMIT_COUNT = 3;
const API_RATE_LIMIT_BASE_BACKOFF_MS = 5 * 60 * 1000;
const API_RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60 * 1000;
const API_RATE_LIMIT_SAFETY_MARGIN_MS = 30 * 1000;

const MEETING_LINK_PATTERN = /https:\/\/(?:teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/|teams\.live\.com\/meet\/)[^\s"'<>]+/i;
const ROOM_NAME_PATTERN = /Групп\s+(\S+)\s*\(/i;
const RATE_LIMIT_ERROR_PATTERN = /too many requests|rate.?limit/i;
const RETRY_AFTER_PATTERN = /retry after\s+(.+?GMT)/i;

function cleanMeetingLink(value) {
  const decoded = String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&');
  const match = decoded.match(MEETING_LINK_PATTERN);
  return match ? match[0].replace(/[.,;!?]+$/, '') : '';
}

function extractMeetingLink(event) {
  for (const candidate of [event?.onlineMeetingUrl, event?.location, event?.body]) {
    const link = cleanMeetingLink(candidate);
    if (link) return link;
  }
  return '';
}

function meetingKey(link, start) {
  return `${link}::${new Date(start).toISOString()}`;
}

function normalizeStoredMeetingKey(key) {
  const value = String(key || '');
  const separator = value.lastIndexOf('::');
  if (separator < 0) return value;
  const link = value.slice(0, separator);
  const start = new Date(value.slice(separator + 2));
  return Number.isNaN(start.getTime()) ? value : meetingKey(link, start);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function isRateLimitError(error) {
  return RATE_LIMIT_ERROR_PATTERN.test(error?.message || '');
}

function subjectMatchesAllowlist(subject, allowedSubjects) {
  if (!Array.isArray(allowedSubjects) || !allowedSubjects.length) return false;
  const normalized = String(subject || '').toLowerCase();
  return allowedSubjects.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

function parseRetryAfter(message) {
  const match = String(message || '').match(RETRY_AFTER_PATTERN);
  if (!match) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Prefer the server's own "retry after" hint when it parses to a real, still-future
// date; otherwise fall back to a doubling backoff (5m, 10m, 20m, ... capped at 1h) so
// repeated rate-limit responses (with no usable hint, or a stale/malformed one) don't
// keep the monitor hammering the API every single poll cycle.
function computeBackoffUntil({ error, now, consecutiveHits }) {
  const retryAfter = parseRetryAfter(error?.message);
  if (retryAfter && retryAfter.getTime() > now.getTime()) {
    return new Date(retryAfter.getTime() + API_RATE_LIMIT_SAFETY_MARGIN_MS);
  }
  const exponent = Math.min(Math.max(consecutiveHits, 1) - 1, 6);
  const delay = Math.min(API_RATE_LIMIT_BASE_BACKOFF_MS * 2 ** exponent, API_RATE_LIMIT_MAX_BACKOFF_MS);
  return new Date(now.getTime() + delay);
}

function firefliesErrorMessage(errors) {
  if (!Array.isArray(errors) || !errors.length) return 'Fireflies вернул неизвестную ошибку.';
  return errors
    .map((item) => item?.message || item?.extensions?.code || String(item))
    .filter(Boolean)
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
}

class FirefliesApi {
  constructor({ fetchImpl = globalThis.fetch, endpoint = FIREFLIES_GRAPHQL_URL } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('В этой версии приложения недоступны HTTPS-запросы к Fireflies.');
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
  }

  async request(apiKey, query, variables = {}) {
    if (!apiKey) throw new Error('Укажите API-ключ Fireflies.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Fireflies не ответил за 15 секунд.');
      throw new Error(`Не удалось подключиться к Fireflies: ${error?.message || error}`);
    } finally {
      clearTimeout(timeout);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Fireflies вернул некорректный ответ (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(`Fireflies отклонил запрос (HTTP ${response.status}): ${firefliesErrorMessage(payload?.errors)}`);
    if (payload?.errors?.length) throw new Error(firefliesErrorMessage(payload.errors));
    return payload?.data || {};
  }

  async testConnection(apiKey) {
    const data = await this.request(apiKey, 'query CurrentUser { user { user_id email name } }');
    if (!data.user) throw new Error('Fireflies не вернул данные владельца API-ключа.');
    return { ok: true, email: data.user.email || '', name: data.user.name || '' };
  }

  async addToLiveMeeting(apiKey, { link, title, durationMinutes }) {
    const query = `
      mutation AddToLiveMeeting($meetingLink: String!, $title: String, $duration: Int) {
        addToLiveMeeting(meeting_link: $meetingLink, title: $title, duration: $duration) {
          success
          message
        }
      }
    `;
    const data = await this.request(apiKey, query, {
      meetingLink: link,
      title: String(title || '').slice(0, 256),
      duration: clampInteger(durationMinutes, 15, 120, 60),
    });
    const result = data.addToLiveMeeting || {};
    if (!result.success) throw new Error(result.message || 'Fireflies не подтвердил подключение бота.');
    return result;
  }

  async hasTranscript(apiKey, { link, title, fromDate, toDate }) {
    const query = `
      query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int) {
        transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit) {
          id
          title
          meeting_link
        }
      }
    `;
    const data = await this.request(apiKey, query, {
      fromDate: new Date(fromDate).toISOString(),
      toDate: new Date(toDate).toISOString(),
      limit: 50,
    });
    return (data.transcripts || []).some((item) => item.meeting_link === link || item.title === title);
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function formatMeetingDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timeZone || 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(date));
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('day')}.${value('month')}.${value('year')} - ${value('hour')}:${value('minute')}`;
}

function buildMeetingTitle(event, timeZone) {
  const subject = event.subject || 'Встреча без названия';
  const room = String(event.location || '').match(ROOM_NAME_PATTERN)?.[1];
  const dateTime = formatMeetingDate(event.start, timeZone);
  return room ? `${subject} - ${room} - (${dateTime})` : `${subject} - (${dateTime})`;
}

class FirefliesMonitor {
  constructor({ configStore, createEwsClient, statePath, onStatus = () => {}, api = new FirefliesApi(), now = () => new Date() }) {
    this.configStore = configStore;
    this.createEwsClient = createEwsClient;
    this.statePath = statePath;
    this.onStatus = onStatus;
    this.api = api;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.lastDeferredKey = '';
    this.data = this.#loadState();
    this.currentStatus = {
      mode: 'stopped',
      title: 'Fireflies остановлен',
      detail: 'Мониторинг ещё не запущен',
      lastCheckedAt: null,
      nextCheckAt: null,
    };
  }

  #loadState() {
    const raw = readJson(this.statePath, {});
    if (Array.isArray(raw)) {
      return {
        processed: Object.fromEntries(raw.map((key) => [normalizeStoredMeetingKey(key), { sentAt: null, status: 'sent' }])),
        pending: [],
        logs: [],
        rateLimitedUntil: null,
        rateLimitConsecutiveHits: 0,
      };
    }
    const processed = {};
    for (const [key, value] of Object.entries(raw?.processed || {})) processed[normalizeStoredMeetingKey(key)] = value;
    return {
      processed,
      pending: Array.isArray(raw?.pending) ? raw.pending : [],
      logs: Array.isArray(raw?.logs) ? raw.logs.slice(-MAX_LOG_ENTRIES) : [],
      rateLimitedUntil: raw?.rateLimitedUntil || null,
      rateLimitConsecutiveHits: Number.isFinite(raw?.rateLimitConsecutiveHits) ? raw.rateLimitConsecutiveHits : 0,
    };
  }

  #saveState() {
    const cutoff = this.now().getTime() - MAX_PROCESSED_AGE_MS;
    for (const [key, item] of Object.entries(this.data.processed)) {
      const timestamp = new Date(item?.sentAt || 0).getTime();
      if (timestamp && timestamp < cutoff) delete this.data.processed[key];
    }
    fs.mkdirSync(require('node:path').dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  }

  #log(level, message) {
    this.data.logs.push({ at: this.now().toISOString(), level, message: String(message).slice(0, 500) });
    this.data.logs = this.data.logs.slice(-MAX_LOG_ENTRIES);
    this.#saveState();
  }

  #publish(patch = {}) {
    this.currentStatus = { ...this.currentStatus, ...patch };
    const payload = this.getStatus();
    this.onStatus(payload);
    return payload;
  }

  getStatus() {
    return {
      ...this.currentStatus,
      processedCount: Object.keys(this.data.processed).length,
      pendingCount: this.data.pending.length,
      logs: this.data.logs.slice(-60).reverse(),
    };
  }

  #activeBackoff(now) {
    return this.data.rateLimitedUntil && new Date(this.data.rateLimitedUntil) > now ? new Date(this.data.rateLimitedUntil) : null;
  }

  // Returns true when `error` was a Fireflies rate-limit response, having already
  // recorded a backoff window for it; callers should stop making further Fireflies
  // requests for the rest of the current tick when this returns true.
  #handleRateLimit(error, now) {
    if (!isRateLimitError(error)) return false;
    this.data.rateLimitConsecutiveHits = (this.data.rateLimitConsecutiveHits || 0) + 1;
    this.data.rateLimitedUntil = computeBackoffUntil({ error, now, consecutiveHits: this.data.rateLimitConsecutiveHits }).toISOString();
    this.#saveState();
    return true;
  }

  #clearRateLimit() {
    if (this.data.rateLimitConsecutiveHits || this.data.rateLimitedUntil) {
      this.data.rateLimitConsecutiveHits = 0;
      this.data.rateLimitedUntil = null;
    }
  }

  async testApi(apiKey) {
    const config = this.configStore.load();
    const now = this.now();
    const until = this.#activeBackoff(now);
    if (until) throw new Error(`Fireflies временно ограничил частоту запросов. Попробуйте после ${formatMeetingDate(until, config.timeZone)}.`);
    try {
      const result = await this.api.testConnection(apiKey || config.firefliesApiKey);
      this.#clearRateLimit();
      return result;
    } catch (error) {
      this.#handleRateLimit(error, now);
      throw error;
    }
  }

  start() {
    this.stopped = false;
    return this.runNow();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.#publish({ mode: 'stopped', title: 'Fireflies остановлен', detail: 'Приложение завершает работу', nextCheckAt: null });
  }

  reconfigure() {
    if (this.stopped) return;
    return this.runNow();
  }

  async runNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return this.getStatus();
    this.running = true;
    try {
      await this.#tick();
    } catch (error) {
      this.#log('error', error?.message || String(error));
      this.#publish({ mode: 'error', title: 'Ошибка Fireflies', detail: error?.message || String(error), lastCheckedAt: this.now().toISOString() });
    } finally {
      this.running = false;
      if (!this.stopped) this.#scheduleNext();
    }
    return this.getStatus();
  }

  #scheduleNext() {
    const config = this.configStore.load();
    const seconds = clampInteger(config.firefliesPollSeconds, 30, 600, 60);
    const nextCheckAt = new Date(this.now().getTime() + seconds * 1000).toISOString();
    this.#publish({ nextCheckAt });
    this.timer = setTimeout(() => this.runNow(), seconds * 1000);
  }

  #recentDispatchCount(now) {
    const cutoff = now.getTime() - LOCAL_RATE_LIMIT_WINDOW_MS;
    return Object.values(this.data.processed).filter((item) => new Date(item?.sentAt || 0).getTime() >= cutoff).length;
  }

  async #processVerifications(config, now) {
    const stillPending = [];
    let rateLimited = false;
    for (const item of this.data.pending) {
      if (rateLimited || new Date(item.nextCheckAt) > now) {
        stillPending.push(item);
        continue;
      }
      let found = false;
      try {
        found = await this.api.hasTranscript(config.firefliesApiKey, {
          link: item.link,
          title: item.title,
          fromDate: new Date(new Date(item.start).getTime() - 5 * 60 * 1000),
          toDate: new Date(new Date(item.end).getTime() + (config.firefliesVerifyDelayMinutes + config.firefliesVerifyRetryMinutes * config.firefliesVerifyMaxAttempts + 5) * 60 * 1000),
        });
      } catch (error) {
        if (this.#handleRateLimit(error, now)) {
          // Not the item's fault — don't burn an attempt, just retry once the pause ends.
          rateLimited = true;
          this.#log('warning', `Fireflies ограничил частоту запросов при проверке записи «${item.title}» — приостанавливаю проверки до ${formatMeetingDate(this.data.rateLimitedUntil, config.timeZone)}.`);
          stillPending.push(item);
          continue;
        }
        this.#log('error', `Не удалось проверить запись «${item.title}»: ${error.message}`);
      }
      this.#clearRateLimit();
      if (found) {
        if (this.data.processed[item.key]) this.data.processed[item.key].status = 'recorded';
        this.#log('success', `Подтверждена запись встречи «${item.title}».`);
        continue;
      }
      item.attempts = (item.attempts || 0) + 1;
      if (item.attempts >= config.firefliesVerifyMaxAttempts) {
        if (this.data.processed[item.key]) this.data.processed[item.key].status = 'not-confirmed';
        this.#log('warning', `Запись встречи «${item.title}» не подтверждена после ${item.attempts} проверок.`);
        continue;
      }
      item.nextCheckAt = new Date(now.getTime() + config.firefliesVerifyRetryMinutes * 60 * 1000).toISOString();
      stillPending.push(item);
    }
    this.data.pending = stillPending;
  }

  async #tick() {
    const config = this.configStore.load();
    if (!config.firefliesEnabled) {
      this.#publish({ mode: 'disabled', title: 'Fireflies выключен', detail: 'Включите мониторинг в настройках', lastCheckedAt: this.now().toISOString() });
      return;
    }
    if (!config.firefliesApiKey) {
      this.#publish({ mode: 'needs-configuration', title: 'Нужен ключ Fireflies', detail: 'Откройте Настройки → Fireflies', lastCheckedAt: this.now().toISOString() });
      return;
    }

    const now = this.now();
    const backoffUntil = this.#activeBackoff(now);
    if (backoffUntil) {
      this.#publish({
        mode: 'rate-limited',
        title: 'Fireflies: пауза после ограничения API',
        detail: `Возобновлю проверку не раньше ${formatMeetingDate(backoffUntil, config.timeZone)}`,
        lastCheckedAt: now.toISOString(),
      });
      return;
    }

    this.#publish({ mode: 'checking', title: 'Fireflies: проверка', detail: 'Ищу начинающиеся Teams-встречи…' });
    try {
      await this.#processVerifications(config, now);
      if (this.#activeBackoff(now)) {
        // A verification call just tripped the rate limit — don't also try sending
        // new bots in the same tick, it would just fail the same way.
        this.#saveState();
        this.#publish({ mode: 'rate-limited', title: 'Fireflies: пауза после ограничения API', detail: `Возобновлю проверку не раньше ${formatMeetingDate(this.data.rateLimitedUntil, config.timeZone)}`, lastCheckedAt: now.toISOString() });
        return;
      }
      const leadMinutes = clampInteger(config.firefliesJoinLeadMinutes, 0, 10, 1);
      const pollSeconds = clampInteger(config.firefliesPollSeconds, 30, 600, 60);
      const start = new Date(now.getTime() - 2 * 60 * 1000);
      const end = new Date(now.getTime() + (leadMinutes + pollSeconds / 60 + 2) * 60 * 1000);
      const events = await this.createEwsClient().getBridgeEvents(start, end);
      const unique = new Map();
      for (const event of events) {
        const link = extractMeetingLink(event);
        if (!link || !event.start || !event.end || event.cancelled) continue;
        unique.set(meetingKey(link, event.start), { event, link });
      }

      for (const [key, { event, link }] of unique) {
        if (this.data.processed[key]) continue;
        const eventStart = new Date(event.start);
        if (eventStart.getTime() - leadMinutes * 60 * 1000 > now.getTime()) continue;
        if (!subjectMatchesAllowlist(event.subject, config.firefliesAllowedSubjects)) continue;
        if (this.#recentDispatchCount(now) >= LOCAL_RATE_LIMIT_COUNT) {
          if (this.lastDeferredKey !== key) {
            this.#log('warning', `Встреча «${event.subject || 'Без названия'}» ожидает лимита Fireflies (не более 3 подключений за 20 минут).`);
            this.lastDeferredKey = key;
          }
          continue;
        }
        const title = buildMeetingTitle(event, config.timeZone);
        const durationMinutes = Math.max(1, Math.round((new Date(event.end) - eventStart) / 60_000));
        try {
          await this.api.addToLiveMeeting(config.firefliesApiKey, { link, title, durationMinutes });
        } catch (error) {
          if (this.#handleRateLimit(error, now)) {
            this.#log('warning', `Fireflies ограничил частоту запросов — отправка «${title}» будет повторена не раньше ${formatMeetingDate(this.data.rateLimitedUntil, config.timeZone)}.`);
            break; // stop trying more meetings this tick, it would just fail the same way
          }
          this.#log('error', `Не удалось отправить бота на встречу «${title}»: ${error.message}`);
          continue; // isolate this meeting's failure — keep processing the rest of the batch
        }
        this.#clearRateLimit();
        this.data.processed[key] = { title, start: event.start, sentAt: now.toISOString(), status: 'sent' };
        this.data.pending.push({
          key,
          title,
          link,
          start: event.start,
          end: event.end,
          nextCheckAt: new Date(new Date(event.end).getTime() + config.firefliesVerifyDelayMinutes * 60 * 1000).toISOString(),
          attempts: 0,
        });
        this.lastDeferredKey = '';
        this.#log('success', `Бот Fireflies отправлен на встречу «${title}».`);
      }
      this.#saveState();
      const rateLimitedNow = this.#activeBackoff(now);
      this.#publish(rateLimitedNow ? {
        mode: 'rate-limited',
        title: 'Fireflies: пауза после ограничения API',
        detail: `Возобновлю проверку не раньше ${formatMeetingDate(rateLimitedNow, config.timeZone)}`,
        lastCheckedAt: now.toISOString(),
      } : {
        mode: 'running',
        title: 'Fireflies работает',
        detail: `Проверено Teams-встреч: ${unique.size}`,
        lastCheckedAt: now.toISOString(),
      });
    } catch (error) {
      if (this.#handleRateLimit(error, now)) {
        this.#publish({ mode: 'rate-limited', title: 'Fireflies: пауза после ограничения API', detail: `Возобновлю проверку не раньше ${formatMeetingDate(this.data.rateLimitedUntil, config.timeZone)}`, lastCheckedAt: now.toISOString() });
        return;
      }
      this.#log('error', error?.message || String(error));
      this.#publish({ mode: 'error', title: 'Ошибка Fireflies', detail: error?.message || String(error), lastCheckedAt: now.toISOString() });
    }
  }
}

module.exports = {
  FirefliesApi,
  FirefliesMonitor,
  buildMeetingTitle,
  cleanMeetingLink,
  computeBackoffUntil,
  extractMeetingLink,
  firefliesErrorMessage,
  isRateLimitError,
  meetingKey,
  normalizeStoredMeetingKey,
  parseRetryAfter,
  subjectMatchesAllowlist,
};

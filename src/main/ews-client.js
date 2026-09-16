const ews = require('ews-javascript-api');
const { XhrApi } = require('@ewsjs/xhr');
const { assignEventsToRooms } = require('./rooms');

const FREE_BUSY = ['free', 'tentative', 'busy', 'out-of-office', 'working-elsewhere', 'unknown'];

function ewsDateToIso(value) {
  if (!value) return null;
  if (typeof value.ToISOString === 'function') return value.ToISOString();
  if (value.MomentDate && typeof value.MomentDate.toISOString === 'function') return value.MomentDate.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function collectionToArray(collection) {
  if (!collection) return [];
  if (typeof collection.GetEnumerator === 'function') return collection.GetEnumerator();
  if (Array.isArray(collection)) return collection;
  return [];
}

function bodyToText(value) {
  if (!value) return '';
  if (typeof value.Text === 'string') return value.Text;
  if (typeof value.ToString === 'function') return value.ToString();
  return String(value);
}

function serializeAppointment(appointment, mailbox, { includeBody = false } = {}) {
  const resources = collectionToArray(appointment.Resources)
    .map((resource) => resource.Name || resource.Address)
    .filter(Boolean);
  const itemId = appointment.Id?.UniqueId || '';
  const result = {
    id: itemId,
    uid: appointment.ICalUid || itemId,
    subject: appointment.Subject || 'Занято',
    start: ewsDateToIso(appointment.Start),
    end: ewsDateToIso(appointment.End),
    location: appointment.Location || '',
    resources,
    organizer: appointment.Organizer?.Name || appointment.Organizer?.Address || '',
    organizerEmail: appointment.Organizer?.Address || '',
    sourceMailboxes: [mailbox],
    allDay: Boolean(appointment.IsAllDayEvent),
    cancelled: Boolean(appointment.IsCancelled),
    recurring: Boolean(appointment.IsRecurring),
    isOnlineMeeting: Boolean(appointment.IsOnlineMeeting),
    onlineMeetingUrl: appointment.JoinOnlineMeetingUrl || '',
    freeBusy: FREE_BUSY[appointment.LegacyFreeBusyStatus] || 'unknown',
  };
  if (includeBody) {
    try {
      result.body = bodyToText(appointment.Body);
    } catch {
      result.body = '';
    }
  }
  return result;
}

function deduplicateEvents(events) {
  const unique = new Map();
  for (const event of events) {
    if (!event.start || !event.end || event.cancelled) continue;
    const key = [event.uid || event.id, event.start, event.end, event.location.toLocaleLowerCase('ru-RU')].join('|');
    const previous = unique.get(key);
    if (previous) {
      previous.sourceMailboxes = [...new Set([...previous.sourceMailboxes, ...event.sourceMailboxes])];
      if ((!previous.subject || previous.subject === 'Занято') && event.subject) previous.subject = event.subject;
    } else {
      unique.set(key, { ...event });
    }
  }
  return [...unique.values()].sort((a, b) => a.start.localeCompare(b.start));
}

function safeError(error, config) {
  let message = error?.message || error?.statusText || String(error || 'Неизвестная ошибка Exchange');
  for (const secret of [config.password, config.username]) {
    if (secret) message = message.split(secret).join('***');
  }
  if (/401|unauthori[sz]ed|не авториз/i.test(message)) return 'EWS отклонил имя пользователя или пароль (HTTP 401).';
  if (/403|forbidden|access.*denied/i.test(message)) return 'Нет права на чтение этого календаря (HTTP 403).';
  if (/404|not found/i.test(message)) return 'EWS не найден. Проверьте сервер и путь /EWS/Exchange.asmx.';
  if (/certificate|self.?signed|unable to verify/i.test(message)) return 'Не удалось проверить TLS-сертификат EWS-сервера.';
  if (/reading 'headers'/i.test(message)) return 'Нет соединения с сервером Exchange: сервер не ответил на запрос авторизации NTLM. Проверьте сеть/VPN и адрес сервера, затем повторите попытку.';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network.?error/i.test(message)) return 'Нет соединения с сервером Exchange. Проверьте сеть/VPN и адрес сервера.';
  return message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 420);
}

class EwsCalendarClient {
  constructor(config, configuredRooms = []) {
    this.config = config;
    this.configuredRooms = configuredRooms;
    this.service = null;
  }

  #createService() {
    const { username, password, auth } = this.config;
    const xhr = new XhrApi({ timeout: 45_000, rejectUnauthorized: true });
    if (auth === 'ntlm') xhr.useNtlmAuthentication(username, password);
    ews.ConfigurationApi.ConfigureXHR(xhr);

    const service = new ews.ExchangeService(ews.ExchangeVersion.Exchange2013_SP1);
    service.Credentials = new ews.WebCredentials(username, password);
    service.Url = new ews.Uri(`https://${this.config.server}${this.config.ewsPath}`);
    service.Timeout = 45_000;
    return service;
  }

  async #fetchMailbox(mailbox, start, end) {
    const folderId = new ews.FolderId(ews.WellKnownFolderName.Calendar, new ews.Mailbox(mailbox));
    const view = new ews.CalendarView(new ews.DateTime(start), new ews.DateTime(end), 1000);
    view.PropertySet = ews.PropertySet.FirstClassProperties;
    const result = await this.service.FindAppointments(folderId, view);
    return (result.Items || []).map((appointment) => serializeAppointment(appointment, mailbox));
  }

  async #fetchMailboxForBridge(mailbox, start, end) {
    const folderId = new ews.FolderId(ews.WellKnownFolderName.Calendar, new ews.Mailbox(mailbox));
    const view = new ews.CalendarView(new ews.DateTime(start), new ews.DateTime(end), 100);
    view.PropertySet = ews.PropertySet.FirstClassProperties;
    const result = await this.service.FindAppointments(folderId, view);
    return Promise.all((result.Items || []).map(async (appointment) => {
      try {
        const detailed = await ews.Appointment.Bind(this.service, appointment.Id, ews.PropertySet.FirstClassProperties);
        return serializeAppointment(detailed, mailbox, { includeBody: true });
      } catch {
        // JoinOnlineMeetingUrl and Location are often already present in FindAppointments.
        // Keep the shallow result when loading the body of one item is not permitted.
        return serializeAppointment(appointment, mailbox, { includeBody: true });
      }
    }));
  }

  async getSchedule(start, end) {
    this.service = this.#createService();
    const results = await Promise.allSettled(
      this.config.mailboxes.map((mailbox) => this.#fetchMailbox(mailbox, start, end)),
    );
    const events = [];
    const mailboxResults = results.map((result, index) => {
      const mailbox = this.config.mailboxes[index];
      if (result.status === 'fulfilled') {
        events.push(...result.value);
        return { mailbox, ok: true, eventCount: result.value.length };
      }
      return { mailbox, ok: false, eventCount: 0, error: safeError(result.reason, this.config) };
    });
    if (mailboxResults.every((result) => !result.ok)) {
      const error = new Error(mailboxResults[0]?.error || 'Не удалось прочитать календари Exchange.');
      error.mailboxResults = mailboxResults;
      throw error;
    }
    const uniqueEvents = deduplicateEvents(events);
    const assignment = assignEventsToRooms(uniqueEvents, this.configuredRooms);
    return {
      range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      rooms: assignment.rooms,
      online: assignment.online,
      mailboxResults,
      eventCount: uniqueEvents.length,
      unassignedCount: assignment.unassignedCount,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getBridgeEvents(start, end) {
    this.service = this.#createService();
    const results = await Promise.allSettled(
      this.config.mailboxes.map((mailbox) => this.#fetchMailboxForBridge(mailbox, start, end)),
    );
    const events = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    if (!events.length && results.every((result) => result.status === 'rejected')) {
      throw new Error(safeError(results[0]?.reason, this.config));
    }
    return events;
  }

  async testConnection() {
    const now = new Date();
    const end = new Date(now.getTime() + 60 * 60 * 1000);
    const schedule = await this.getSchedule(now, end);
    return { ok: true, mailboxResults: schedule.mailboxResults };
  }
}

module.exports = {
  EwsCalendarClient,
  deduplicateEvents,
  ewsDateToIso,
  serializeAppointment,
  bodyToText,
  safeError,
};

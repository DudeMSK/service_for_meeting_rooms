const api = window.meetingRooms;

const elements = {
  roomList: document.querySelector('#roomList'),
  roomCount: document.querySelector('#roomCount'),
  onlineList: document.querySelector('#onlineList'),
  onlineCount: document.querySelector('#onlineCount'),
  syncState: document.querySelector('#syncState'),
  periodTitle: document.querySelector('#periodTitle'),
  roomSummary: document.querySelector('#roomSummary'),
  calendar: document.querySelector('#calendar'),
  refreshButton: document.querySelector('#refreshButton'),
  settingsDialog: document.querySelector('#settingsDialog'),
  settingsForm: document.querySelector('#settingsForm'),
  testResult: document.querySelector('#testResult'),
  testButton: document.querySelector('#testButton'),
  saveButton: document.querySelector('#saveButton'),
  mailboxesInfo: document.querySelector('#mailboxesInfo'),
  appVersionLabel: document.querySelector('#appVersionLabel'),
  updateStatus: document.querySelector('#updateStatus'),
  updateButton: document.querySelector('#updateButton'),
  eventDialog: document.querySelector('#eventDialog'),
  eventDetails: document.querySelector('#eventDetails'),
  toastRegion: document.querySelector('#toastRegion'),
};

const state = {
  anchor: startOfDay(new Date()),
  view: 'day',
  config: null,
  schedule: null,
  selectedRoomId: null,
  eventMap: new Map(),
  loading: false,
  refreshTimer: null,
  updateMode: 'idle',
};

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

const icons = {
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4.2 4.2L19 6.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 9h17"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path d="M10.3 4.2 2.7 17.4A1.8 1.8 0 0 0 4.3 20h15.4a1.8 1.8 0 0 0 1.6-2.6L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 16.5h.01"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function startOfWeek(value) {
  const date = startOfDay(value);
  const day = date.getDay() || 7;
  return addDays(date, 1 - day);
}

function startOfMonth(value) {
  const date = startOfDay(value);
  date.setDate(1);
  return date;
}

function addMonths(value, months) {
  const date = startOfMonth(value);
  date.setMonth(date.getMonth() + months);
  return date;
}

function sameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function overlaps(event, start, end) {
  return new Date(event.start) < end && new Date(event.end) > start;
}

function visibleRange() {
  if (state.view === 'day') {
    const start = startOfDay(state.anchor);
    return { start, end: addDays(start, 1), displayStart: start, displayEnd: addDays(start, 1) };
  }
  if (state.view === 'week') {
    const start = startOfWeek(state.anchor);
    return { start, end: addDays(start, 7), displayStart: start, displayEnd: addDays(start, 7) };
  }
  const monthStart = startOfMonth(state.anchor);
  const monthEnd = addMonths(monthStart, 1);
  const displayStart = startOfWeek(monthStart);
  const lastDay = addDays(monthEnd, -1);
  const displayEnd = addDays(startOfWeek(lastDay), 7);
  return { start: displayStart, end: displayEnd, displayStart, displayEnd, monthStart, monthEnd };
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat('ru-RU', options).format(date);
}

function capitalize(value) {
  return value ? value[0].toLocaleUpperCase('ru-RU') + value.slice(1) : '';
}

function formatTime(value) {
  return formatDate(new Date(value), { hour: '2-digit', minute: '2-digit' });
}

function formatPeriodTitle() {
  const range = visibleRange();
  if (state.view === 'day') {
    return capitalize(formatDate(range.start, { weekday: 'long', day: 'numeric', month: 'long' }));
  }
  if (state.view === 'week') {
    const last = addDays(range.end, -1);
    if (range.start.getMonth() === last.getMonth()) {
      const fullEnd = formatDate(last, { day: 'numeric', month: 'long', year: 'numeric' });
      return `${range.start.getDate()}–${fullEnd}`;
    }
    return `${formatDate(range.start, { day: 'numeric', month: 'short' })} — ${formatDate(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return capitalize(formatDate(range.monthStart, { month: 'long', year: 'numeric' }));
}

function selectedResource() {
  const room = state.schedule?.rooms.find((item) => item.id === state.selectedRoomId);
  if (room) return room;
  return state.schedule?.online?.id === state.selectedRoomId ? state.schedule.online : null;
}

function activeEvent(room, now = new Date()) {
  return room?.events.find((event) => new Date(event.start) <= now && new Date(event.end) > now) || null;
}

function nextEvent(room, now = new Date()) {
  return room?.events.find((event) => new Date(event.start) > now) || null;
}

function eventKey(room, event) {
  return `${room.id}|${event.id || event.uid}|${event.start}`;
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

function cleanError(error) {
  return String(error?.message || error || 'Неизвестная ошибка')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function applyAppearance(config = state.config) {
  const selectedMainTheme = config?.mainTheme || config?.theme || 'system';
  const selectedSidebarTheme = config?.sidebarTheme || 'dark';
  const resolvedMainTheme = selectedMainTheme === 'system'
    ? (systemTheme.matches ? 'dark' : 'light')
    : selectedMainTheme;
  const resolvedSidebarTheme = selectedSidebarTheme === 'match-main'
    ? resolvedMainTheme
    : selectedSidebarTheme;

  document.documentElement.dataset.mainTheme = resolvedMainTheme;
  document.documentElement.dataset.mainThemePreference = selectedMainTheme;
  document.documentElement.dataset.mainAccent = config?.mainAccent || config?.accent || 'green';
  document.documentElement.dataset.sidebarTheme = resolvedSidebarTheme;
  document.documentElement.dataset.sidebarThemePreference = selectedSidebarTheme;
  document.documentElement.dataset.sidebarAccent = config?.sidebarAccent || config?.accent || 'green';
}

function setSyncStatus(kind, title, detail) {
  elements.syncState.className = `sync-state ${kind}`;
  elements.syncState.innerHTML = `<span class="sync-dot"></span><div><strong>${escapeHtml(title)}</strong><small title="${escapeHtml(detail)}">${escapeHtml(detail)}</small></div>`;
}

function renderRoomList() {
  const rooms = state.schedule?.rooms || [];
  const online = state.schedule?.online || { id: 'online-meetings', name: 'Все онлайн встречи', source: 'online', events: [] };
  elements.roomCount.textContent = String(rooms.length);
  elements.onlineCount.textContent = String(online.events.length);
  if (!rooms.length) {
    elements.roomList.innerHTML = '<div class="sidebar-empty">Комнаты появятся после чтения поля «Место» во встречах или после заполнения rooms.json.</div>';
  } else {
    const now = new Date();
    const range = visibleRange();
    const showsNow = now >= range.start && now < range.end;
    elements.roomList.innerHTML = rooms.map((room) => {
      const active = showsNow ? activeEvent(room, now) : null;
      const upcoming = showsNow ? nextEvent(room, now) : null;
      let detail = `${room.events.length} ${plural(room.events.length, 'встреча', 'встречи', 'встреч')}`;
      let status = 'future';
      if (active) {
        detail = `Занята до ${formatTime(active.end)}`;
        status = 'busy';
      } else if (showsNow) {
        detail = upcoming ? `Свободна · далее в ${formatTime(upcoming.start)}` : 'Свободна до конца периода';
        status = '';
      }
      return `<button class="room-item ${room.id === state.selectedRoomId ? 'active' : ''}" data-room-id="${escapeHtml(room.id)}" type="button">
        <span class="status-indicator ${status}"></span>
        <span><span class="room-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span><span class="room-state ${active ? 'busy' : ''}">${escapeHtml(detail)}</span></span>
      </button>`;
    }).join('');
  }

  const now = new Date();
  const range = visibleRange();
  const showsNow = now >= range.start && now < range.end;
  const onlineActive = showsNow ? online.events.filter((event) => new Date(event.start) <= now && new Date(event.end) > now) : [];
  const onlineNext = showsNow ? nextEvent(online, now) : online.events[0] || null;
  let onlineDetail = `${online.events.length} ${plural(online.events.length, 'встреча', 'встречи', 'встреч')} в периоде`;
  if (onlineActive.length) onlineDetail = `Сейчас ${onlineActive.length} ${plural(onlineActive.length, 'встреча', 'встречи', 'встреч')}`;
  else if (onlineNext) onlineDetail = `Далее ${formatOnlineEventMoment(onlineNext)}`;
  else onlineDetail = 'Нет встреч в выбранном периоде';
  elements.onlineList.innerHTML = `<button class="room-item ${online.id === state.selectedRoomId ? 'active' : ''}" data-room-id="${escapeHtml(online.id)}" type="button">
    <span class="status-indicator online"></span>
    <span><span class="room-name">Все онлайн встречи</span><span class="room-state">${escapeHtml(onlineDetail)}</span></span>
  </button>`;
}

function formatOnlineEventMoment(event) {
  const date = new Date(event.start);
  return sameDay(date, new Date())
    ? `сегодня в ${formatTime(date)}`
    : `${formatDate(date, { day: 'numeric', month: 'short' })} в ${formatTime(date)}`;
}

function plural(number, one, few, many) {
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function renderSummary() {
  const room = selectedResource();
  if (!room) {
    elements.roomSummary.innerHTML = `<div class="summary-heading"><div class="summary-eyebrow">Календарь переговорных</div><h2>Выберите комнату</h2><div class="summary-subtitle">Занятость формируется по полю «Место»</div></div>`;
    return;
  }
  const now = new Date();
  const range = visibleRange();
  const showsNow = now >= range.start && now < range.end;
  const current = showsNow ? activeEvent(room, now) : null;
  const upcoming = showsNow ? nextEvent(room, now) : room.events[0] || null;
  let statusTitle = 'Просмотр периода';
  let statusDetail = `${room.events.length} ${plural(room.events.length, 'встреча', 'встречи', 'встреч')} в календаре`;
  let busyClass = '';
  let icon = icons.calendar;
  if (room.source === 'online') {
    const activeOnline = showsNow
      ? room.events.filter((event) => new Date(event.start) <= now && new Date(event.end) > now)
      : [];
    statusTitle = activeOnline.length
      ? `Сейчас ${activeOnline.length === 1 ? 'идет встреча' : `идут ${activeOnline.length} встречи`}`
      : upcoming ? 'Ближайшая онлайн-встреча' : 'Нет онлайн-встреч';
    statusDetail = activeOnline[0]
      ? `${formatTime(activeOnline[0].start)}–${formatTime(activeOnline[0].end)} · ${activeOnline[0].subject}`
      : upcoming ? `${formatOnlineEventMoment(upcoming)} · ${upcoming.subject}` : 'В выбранном периоде онлайн-встреч нет';
    busyClass = 'online';
    icon = icons.video;
  } else if (showsNow && current) {
    statusTitle = 'Сейчас занята';
    statusDetail = `${formatTime(current.start)}–${formatTime(current.end)} · ${current.subject}`;
    busyClass = 'busy';
    icon = icons.clock;
  } else if (showsNow) {
    statusTitle = 'Сейчас свободна';
    statusDetail = upcoming ? `Следующая встреча в ${formatTime(upcoming.start)}` : 'Больше встреч в этом периоде нет';
    icon = icons.check;
  }
  const sourceLabel = room.source === 'online'
    ? 'Teams · Zoom · Телемост'
    : room.source === 'configured' ? 'переговорная комната' : 'обнаружена по месту встречи';
  const roomTitle = room.source === 'online' ? 'Онлайн встречи' : room.name;
  elements.roomSummary.innerHTML = `
    <div class="summary-heading"><div class="summary-eyebrow">${escapeHtml(sourceLabel)}</div><h2>${escapeHtml(roomTitle)}</h2><div class="summary-subtitle">${room.events.length} ${plural(room.events.length, 'событие', 'события', 'событий')} · ${escapeHtml(state.config?.timeZone || 'Europe/Moscow')}</div></div>
    <div class="availability-card ${busyClass}"><div class="availability-icon">${icon}</div><div class="availability-copy"><strong>${escapeHtml(statusTitle)}</strong><span title="${escapeHtml(statusDetail)}">${escapeHtml(statusDetail)}</span></div></div>`;
}

function registerEvent(room, event) {
  const key = eventKey(room, event);
  state.eventMap.set(key, { room, event });
  return escapeHtml(key);
}

function renderCalendar() {
  elements.periodTitle.textContent = formatPeriodTitle();
  state.eventMap.clear();
  if (state.loading && !state.schedule) {
    elements.calendar.innerHTML = '<div class="loading-state"><div class="state-card"><div class="spinner"></div><h3>Читаю Exchange-календари</h3><p>Собираю встречи и распределяю их по переговорным.</p></div></div>';
    return;
  }
  if (!state.schedule) return;
  if (!state.schedule.rooms.length) {
    const extra = state.schedule.unassignedCount
      ? `Найдено ${state.schedule.unassignedCount} ${plural(state.schedule.unassignedCount, 'событие без места', 'события без места', 'событий без места')}.`
      : 'В выбранном периоде встреч с заполненным местом нет.';
    elements.calendar.innerHTML = `<div class="empty-state"><div class="state-card"><div class="state-icon">${icons.calendar}</div><h3>Переговорные пока не найдены</h3><p>${escapeHtml(extra)} Проверьте выбранный период и календари-источники.</p></div></div>`;
    return;
  }
  const room = selectedResource();
  if (!room) return;
  if (state.view === 'day') renderDay(room);
  else if (state.view === 'week') renderWeek(room);
  else renderMonth(room);
}

function renderDay(room) {
  const range = visibleRange();
  const events = room.events.filter((event) => overlaps(event, range.start, range.end));
  const allDay = events.filter((event) => event.allDay);
  const timed = events.filter((event) => !event.allDay).sort((a, b) => a.start.localeCompare(b.start));
  const startHour = 7;
  const endHour = 22;
  const hourHeight = 72;
  const dayStart = new Date(range.start);
  const gridStart = new Date(dayStart); gridStart.setHours(startHour, 0, 0, 0);
  const gridEnd = new Date(dayStart); gridEnd.setHours(endHour, 0, 0, 0);
  const positioned = timed.map((event, index) => {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    const visibleStart = new Date(Math.max(eventStart, gridStart));
    const visibleEnd = new Date(Math.min(eventEnd, gridEnd));
    if (visibleEnd <= visibleStart) return '';
    const top = ((visibleStart - gridStart) / 3_600_000) * hourHeight;
    const height = Math.max(28, ((visibleEnd - visibleStart) / 3_600_000) * hourHeight - 2);
    const overlapping = timed.some((other, otherIndex) => otherIndex !== index && new Date(other.start) < eventEnd && new Date(other.end) > eventStart);
    const previousOverlapCount = timed.slice(0, index).filter((other) => new Date(other.start) < eventEnd && new Date(other.end) > eventStart).length;
    const lane = overlapping ? previousOverlapCount % 2 : 0;
    const horizontal = overlapping ? (lane === 0 ? 'left:12px;right:50.5%;' : 'left:50.5%;right:12px;') : 'left:12px;right:12px;';
    const key = registerEvent(room, event);
    return `<button class="event-block ${event.freeBusy === 'tentative' ? 'tentative' : ''} ${room.source === 'online' ? 'online' : ''}" data-event-key="${key}" type="button" style="top:${top}px;height:${height}px;${horizontal}"><strong>${escapeHtml(event.subject)}</strong><span>${formatTime(event.start)}–${formatTime(event.end)}${event.organizer ? ` · ${escapeHtml(event.organizer)}` : ''}</span></button>`;
  }).join('');
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, index) => {
    const hour = startHour + index;
    return `<span class="hour-label" style="top:${index * hourHeight}px">${String(hour).padStart(2, '0')}:00</span>${index < endHour - startHour ? `<span class="half-hour-line" style="top:${index * hourHeight + hourHeight / 2}px"></span>` : ''}`;
  }).join('');
  const now = new Date();
  const nowTop = ((now - gridStart) / 3_600_000) * hourHeight;
  const nowLine = sameDay(now, dayStart) && now >= gridStart && now <= gridEnd ? `<div class="now-line" style="top:${nowTop}px"></div>` : '';
  const allDayContent = allDay.length
    ? allDay.map((event) => `<button class="all-day-pill ${room.source === 'online' ? 'online' : ''}" data-event-key="${registerEvent(room, event)}" type="button">${escapeHtml(event.subject)}</button>`).join('')
    : '<span class="no-events">Нет событий на весь день</span>';
  elements.calendar.innerHTML = `<div class="day-calendar"><div class="day-all-day"><div class="day-all-day-label">весь день</div><div class="day-all-day-events">${allDayContent}</div></div><div class="day-grid">${hours}${positioned}${nowLine}</div></div>`;
}

function renderWeek(room) {
  const range = visibleRange();
  const today = new Date();
  const columns = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(range.start, index);
    const end = addDays(day, 1);
    const events = room.events.filter((event) => overlaps(event, day, end));
    const content = events.length ? events.map((event) => {
      const time = event.allDay ? 'Весь день' : `${formatTime(event.start)}–${formatTime(event.end)}`;
      return `<button class="week-event ${event.freeBusy === 'tentative' ? 'tentative' : ''} ${room.source === 'online' ? 'online' : ''}" data-event-key="${registerEvent(room, event)}" type="button"><time>${escapeHtml(time)}</time><strong>${escapeHtml(event.subject)}</strong></button>`;
    }).join('') : '<div class="no-events">Свободно</div>';
    return `<section class="week-day ${sameDay(day, today) ? 'today' : ''}"><header class="week-day-header"><span>${formatDate(day, { weekday: 'short' })}</span><strong>${day.getDate()}</strong></header><div class="week-events">${content}</div></section>`;
  }).join('');
  elements.calendar.innerHTML = `<div class="week-grid">${columns}</div>`;
}

function renderMonth(room) {
  const range = visibleRange();
  const today = new Date();
  const numberOfDays = Math.round((range.displayEnd - range.displayStart) / 86_400_000);
  const days = Array.from({ length: numberOfDays }, (_, index) => {
    const day = addDays(range.displayStart, index);
    const end = addDays(day, 1);
    const events = room.events.filter((event) => overlaps(event, day, end));
    const visible = events.slice(0, 3).map((event) => {
      const prefix = event.allDay ? '' : `${formatTime(event.start)} `;
      return `<button class="month-event ${event.freeBusy === 'tentative' ? 'tentative' : ''} ${room.source === 'online' ? 'online' : ''}" title="${escapeHtml(event.subject)}" data-event-key="${registerEvent(room, event)}" type="button">${escapeHtml(prefix + event.subject)}</button>`;
    }).join('');
    const outside = day < range.monthStart || day >= range.monthEnd;
    const more = events.length > 3 ? `<div class="more-events">+ ещё ${events.length - 3}</div>` : '';
    return `<div class="month-day ${outside ? 'outside' : ''} ${sameDay(day, today) ? 'today' : ''}"><div class="month-day-number">${day.getDate()}</div>${visible}${more}</div>`;
  }).join('');
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => `<span>${day}</span>`).join('');
  elements.calendar.innerHTML = `<div class="month-calendar"><div class="month-weekdays">${weekdays}</div><div class="month-grid">${days}</div></div>`;
}

function renderAll() {
  elements.periodTitle.textContent = formatPeriodTitle();
  renderRoomList();
  renderSummary();
  renderCalendar();
}

async function loadSchedule(force = false) {
  if (!state.config?.configured || state.loading) return;
  const range = visibleRange();
  state.loading = true;
  elements.refreshButton.classList.add('spinning');
  setSyncStatus('loading', 'Синхронизация…', 'Читаю Exchange-календари');
  renderCalendar();
  try {
    const previousRoomId = state.selectedRoomId;
    state.schedule = await api.getSchedule({ start: range.start.toISOString(), end: range.end.toISOString(), force });
    const resourceIds = [...state.schedule.rooms.map((room) => room.id), state.schedule.online?.id].filter(Boolean);
    state.selectedRoomId = resourceIds.includes(previousRoomId)
      ? previousRoomId
      : state.schedule.rooms[0]?.id || null;
    const okCount = state.schedule.mailboxResults.filter((item) => item.ok).length;
    const total = state.schedule.mailboxResults.length;
    const fetchedAt = formatTime(state.schedule.fetchedAt);
    setSyncStatus(okCount === total ? 'ok' : 'error', okCount === total ? 'Календари обновлены' : `Прочитано ${okCount} из ${total}`, `Последнее обновление в ${fetchedAt}`);
    const failures = state.schedule.mailboxResults.filter((item) => !item.ok);
    if (failures.length) showToast(`${failures[0].mailbox}: ${failures[0].error}`, 'error');
  } catch (error) {
    state.schedule = null;
    const message = cleanError(error);
    setSyncStatus('error', 'Ошибка Exchange', message);
    elements.calendar.innerHTML = `<div class="error-state"><div class="state-card"><div class="state-icon">${icons.warning}</div><h3>Не удалось прочитать календари</h3><p>${escapeHtml(message)}</p><button class="primary-button" data-action="retry" type="button">Повторить</button></div></div>`;
  } finally {
    state.loading = false;
    elements.refreshButton.classList.remove('spinning');
    if (state.schedule) renderAll();
  }
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  const minutes = Math.max(1, Number(state.config?.refreshMinutes || 5));
  state.refreshTimer = window.setInterval(() => loadSchedule(true), minutes * 60_000);
}

function movePeriod(direction) {
  if (state.view === 'day') state.anchor = addDays(state.anchor, direction);
  else if (state.view === 'week') state.anchor = addDays(state.anchor, direction * 7);
  else state.anchor = addMonths(state.anchor, direction);
  state.schedule = null;
  loadSchedule();
}

function switchSettingsTab(tabName) {
  document.querySelectorAll('.settings-tab').forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.settings-tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
}

function openSettings() {
  const form = elements.settingsForm.elements;
  elements.mailboxesInfo.textContent = (state.config?.mailboxes || []).join('\n');
  form.timeZone.value = state.config?.timeZone || 'Europe/Moscow';
  form.refreshMinutes.value = state.config?.refreshMinutes || 5;
  form.mainTheme.value = state.config?.mainTheme || state.config?.theme || 'system';
  form.mainAccent.value = state.config?.mainAccent || state.config?.accent || 'green';
  form.sidebarTheme.value = state.config?.sidebarTheme || 'dark';
  form.sidebarAccent.value = state.config?.sidebarAccent || state.config?.accent || 'green';
  elements.testResult.hidden = true;
  switchSettingsTab('general');
  resetUpdateUi();
  api.getAppVersion().then((version) => { elements.appVersionLabel.textContent = version; });
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
}

function resetUpdateUi() {
  state.updateMode = 'idle';
  elements.updateButton.disabled = false;
  elements.updateButton.textContent = 'Проверить обновления';
  elements.updateStatus.textContent = '';
  elements.updateStatus.className = 'update-status';
}

function setUpdateStatus(text, kind = '') {
  elements.updateStatus.textContent = text;
  elements.updateStatus.className = kind ? `update-status ${kind}` : 'update-status';
}

function handleUpdateStatus(status) {
  if (status.type === 'checking') {
    state.updateMode = 'checking';
    elements.updateButton.disabled = true;
    elements.updateButton.textContent = 'Проверяю…';
    setUpdateStatus('Проверка обновлений…');
  } else if (status.type === 'not-available') {
    state.updateMode = 'idle';
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'Проверить обновления';
    setUpdateStatus('У вас установлена последняя версия.');
  } else if (status.type === 'available') {
    state.updateMode = 'available';
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'Скачать и установить';
    setUpdateStatus(`Доступна версия ${status.version}.`, 'available');
  } else if (status.type === 'progress') {
    state.updateMode = 'downloading';
    elements.updateButton.disabled = true;
    elements.updateButton.textContent = `Скачивание… ${status.percent}%`;
    setUpdateStatus(`Скачивание обновления: ${status.percent}%.`);
  } else if (status.type === 'downloaded') {
    state.updateMode = 'downloaded';
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'Перезапустить и установить';
    setUpdateStatus(`Версия ${status.version} готова к установке.`, 'available');
  } else if (status.type === 'error') {
    state.updateMode = 'idle';
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'Проверить обновления';
    setUpdateStatus(cleanError(status.message), 'error');
  } else if (status.type === 'not-packaged') {
    state.updateMode = 'idle';
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'Проверить обновления';
    setUpdateStatus('Проверка обновлений недоступна в режиме разработки (npm start) — работает только в установленном приложении.');
  }
}

async function handleUpdateButtonClick() {
  try {
    if (state.updateMode === 'available') {
      elements.updateButton.disabled = true;
      elements.updateButton.textContent = 'Скачивание…';
      await api.downloadUpdate();
    } else if (state.updateMode === 'downloaded') {
      await api.installUpdate();
    } else {
      elements.updateButton.disabled = true;
      elements.updateButton.textContent = 'Проверяю…';
      setUpdateStatus('Проверка обновлений…');
      await api.checkForUpdates();
    }
  } catch (error) {
    state.updateMode = 'idle';
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'Проверить обновления';
    setUpdateStatus(cleanError(error), 'error');
  }
}

function settingsFromForm() {
  const form = elements.settingsForm.elements;
  return {
    timeZone: form.timeZone.value,
    refreshMinutes: form.refreshMinutes.value,
    mainTheme: form.mainTheme.value,
    mainAccent: form.mainAccent.value,
    sidebarTheme: form.sidebarTheme.value,
    sidebarAccent: form.sidebarAccent.value,
  };
}

function previewAppearanceFromForm() {
  applyAppearance({
    ...state.config,
    ...settingsFromForm(),
  });
}

async function testSettings() {
  if (!elements.settingsForm.reportValidity()) return;
  elements.testButton.disabled = true;
  elements.testButton.textContent = 'Проверяю…';
  elements.testResult.hidden = true;
  try {
    const result = await api.testConfig(settingsFromForm());
    const successful = result.mailboxResults.filter((item) => item.ok).length;
    elements.testResult.className = 'test-result';
    elements.testResult.textContent = `Подключение установлено. Доступно календарей: ${successful} из ${result.mailboxResults.length}.`;
    elements.testResult.hidden = false;
  } catch (error) {
    elements.testResult.className = 'test-result error';
    elements.testResult.textContent = cleanError(error);
    elements.testResult.hidden = false;
  } finally {
    elements.testButton.disabled = false;
    elements.testButton.textContent = 'Проверить подключение';
  }
}

async function saveSettings() {
  if (!elements.settingsForm.reportValidity()) return;
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = 'Сохраняю…';
  try {
    state.config = await api.saveConfig(settingsFromForm());
    applyAppearance();
    elements.settingsDialog.close();
    state.schedule = null;
    scheduleAutoRefresh();
    await loadSchedule(true);
    showToast('Настройки подключения сохранены.');
  } catch (error) {
    elements.testResult.className = 'test-result error';
    elements.testResult.textContent = cleanError(error);
    elements.testResult.hidden = false;
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent = 'Сохранить';
  }
}

function showEvent(key) {
  const entry = state.eventMap.get(key);
  if (!entry) return;
  const { room, event } = entry;
  const date = sameDay(new Date(event.start), new Date(event.end))
    ? formatDate(new Date(event.start), { weekday: 'long', day: 'numeric', month: 'long' })
    : `${formatDate(new Date(event.start), { day: 'numeric', month: 'short' })} — ${formatDate(new Date(event.end), { day: 'numeric', month: 'short' })}`;
  const time = event.allDay ? 'Весь день' : `${formatTime(event.start)}–${formatTime(event.end)}`;
  elements.eventDetails.innerHTML = `<div class="event-details"><button class="close-button event-close" data-action="close-event" type="button">×</button><div class="event-kicker">${escapeHtml(room.name)}</div><h2>${escapeHtml(event.subject)}</h2><div class="detail-list">
    <div class="detail-row"><span>Когда</span><strong>${escapeHtml(capitalize(date))}<br>${escapeHtml(time)}</strong></div>
    <div class="detail-row"><span>Место</span><strong>${escapeHtml(event.location || (room.source === 'online' ? 'Онлайн' : room.name))}</strong></div>
    <div class="detail-row"><span>Организатор</span><strong>${escapeHtml(event.organizer || event.organizerEmail || 'Не указан')}</strong></div>
    <div class="detail-row"><span>Источник</span><strong>${escapeHtml(event.sourceMailboxes.join(', '))}</strong></div>
    ${event.recurring ? '<div class="detail-row"><span>Повторение</span><strong>Повторяющаяся встреча</strong></div>' : ''}
  </div></div>`;
  elements.eventDialog.showModal();
}

document.querySelector('#prevButton').addEventListener('click', () => movePeriod(-1));
document.querySelector('#nextButton').addEventListener('click', () => movePeriod(1));
document.querySelector('#todayButton').addEventListener('click', () => {
  state.anchor = startOfDay(new Date());
  state.schedule = null;
  loadSchedule();
});
document.querySelector('#settingsButton').addEventListener('click', openSettings);
elements.refreshButton.addEventListener('click', () => loadSchedule(true));
elements.testButton.addEventListener('click', testSettings);
elements.saveButton.addEventListener('click', saveSettings);
['mainTheme', 'mainAccent', 'sidebarTheme', 'sidebarAccent'].forEach((field) => {
  elements.settingsForm.elements[field].addEventListener('change', previewAppearanceFromForm);
});
document.querySelectorAll('.settings-tab').forEach((button) => {
  button.addEventListener('click', () => switchSettingsTab(button.dataset.tab));
});
elements.updateButton.addEventListener('click', handleUpdateButtonClick);
api.onUpdateStatus(handleUpdateStatus);

document.querySelectorAll('.view-button').forEach((button) => button.addEventListener('click', () => {
  if (state.view === button.dataset.view) return;
  state.view = button.dataset.view;
  document.querySelectorAll('.view-button').forEach((item) => item.classList.toggle('active', item === button));
  state.schedule = null;
  loadSchedule();
}));

elements.roomList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-room-id]');
  if (!button) return;
  state.selectedRoomId = button.dataset.roomId;
  renderAll();
});

elements.onlineList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-room-id]');
  if (!button) return;
  state.selectedRoomId = button.dataset.roomId;
  renderAll();
});

elements.calendar.addEventListener('click', (event) => {
  const eventButton = event.target.closest('[data-event-key]');
  if (eventButton) showEvent(eventButton.dataset.eventKey);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'retry') loadSchedule(true);
});

elements.eventDialog.addEventListener('click', (event) => {
  if (event.target.dataset.action === 'close-event' || event.target === elements.eventDialog) elements.eventDialog.close();
});

elements.settingsDialog.addEventListener('cancel', (event) => {
  if (!state.config?.configured) event.preventDefault();
});
elements.settingsDialog.addEventListener('close', () => applyAppearance());

window.setInterval(() => {
  if (state.schedule && !state.loading) {
    renderRoomList();
    renderSummary();
    if (state.view === 'day') renderCalendar();
  }
}, 60_000);

systemTheme.addEventListener('change', () => {
  const appearanceConfig = elements.settingsDialog.open
    ? { ...state.config, ...settingsFromForm() }
    : state.config;
  const followsSystem = (appearanceConfig?.mainTheme || appearanceConfig?.theme || 'system') === 'system';
  if (followsSystem) applyAppearance(appearanceConfig);
});

async function initialize() {
  try {
    state.config = await api.getConfig();
    applyAppearance();
    scheduleAutoRefresh();
    if (!state.config.configured) {
      renderAll();
      openSettings();
      return;
    }
    await loadSchedule();
  } catch (error) {
    setSyncStatus('error', 'Ошибка запуска', cleanError(error));
    showToast(cleanError(error), 'error');
  }
}

initialize();

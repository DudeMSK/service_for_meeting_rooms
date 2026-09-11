const crypto = require('node:crypto');
const fs = require('node:fs');

const URL_LOCATION = /^https?:\/\//i;
const ONLINE_TOKEN = /^(?:microsoft\s*)?(?:teams?|тимс|zoom|зум|skype|webex|онлайн|online(?: meeting)?|дистант|видео|яндекс\s*телемост)$/i;
const ONLINE_SIGNAL = /(?:^https?:\/\/|teams?|тимс|zoom|зум|skype|webex|онлайн|online(?: meeting)?|дистант|видео|яндекс\s*телемост)/i;

function cleanLocation(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedLocationKey(value) {
  return cleanLocation(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/[\s()[\]{}._-]+/g, '')
    .replace(/ё/g, 'е');
}

function roomId(name) {
  return crypto.createHash('sha1').update(normalizedLocationKey(name)).digest('hex').slice(0, 12);
}

function readConfiguredRooms(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((room) => {
        if (typeof room === 'string') return { name: cleanLocation(room), aliases: [] };
        return {
          id: room.id ? String(room.id) : undefined,
          name: cleanLocation(room.name),
          aliases: Array.isArray(room.aliases) ? room.aliases.map(cleanLocation).filter(Boolean) : [],
        };
      })
      .filter((room) => room.name);
  } catch {
    return [];
  }
}

function locationCandidates(location, resources = []) {
  const values = cleanLocation(location)
    .split(/[;|\n]+/)
    .concat(resources)
    .map(cleanLocation)
    .filter(Boolean)
    .map((value) => {
      if (URL_LOCATION.test(value)) return '';
      return value
        .split(/\s*\/\s*/)
        .filter((part) => !ONLINE_TOKEN.test(part))
        .join(' / ')
        .replace(/^дистант\s+или\s+/i, '')
        .trim();
    })
    .filter(Boolean);
  return [...new Set(values)];
}

function hasOnlineSignal(event) {
  return Boolean(
    event.isOnlineMeeting
    || event.onlineMeetingUrl
    || ONLINE_SIGNAL.test(String(event.location || '')),
  );
}

function createRoomResolver(configuredRooms = [], discoverUnknown = true) {
  const rooms = configuredRooms.map((room) => ({
    id: room.id || roomId(room.name),
    name: room.name,
    source: 'configured',
    aliases: room.aliases || [],
  }));
  const aliases = new Map();
  for (const room of rooms) for (const name of [room.name, ...room.aliases]) aliases.set(normalizedLocationKey(name), room);

  function resolve(candidate) {
    const name = cleanLocation(candidate);
    if (!name) return null;
    const key = normalizedLocationKey(name);
    const known = aliases.get(key);
    if (known) return known;
    if (!discoverUnknown) return null;
    let discovered = rooms.find((room) => room.source === 'discovered' && normalizedLocationKey(room.name) === key);
    if (!discovered) {
      discovered = { id: roomId(name), name, source: 'discovered', aliases: [] };
      rooms.push(discovered);
      aliases.set(key, discovered);
    }
    return discovered;
  }

  return { rooms, resolve };
}

function assignEventsToRooms(events, configuredRooms = []) {
  const resolver = createRoomResolver(configuredRooms, configuredRooms.length === 0);
  const roomEvents = new Map(resolver.rooms.map((room) => [room.id, []]));
  const onlineEvents = [];
  let unassignedCount = 0;

  for (const event of events) {
    const candidates = locationCandidates(event.location, event.resources);
    const assignedIds = new Set();
    for (const candidate of candidates) {
      const room = resolver.resolve(candidate);
      if (!room || assignedIds.has(room.id)) continue;
      assignedIds.add(room.id);
      if (!roomEvents.has(room.id)) roomEvents.set(room.id, []);
      roomEvents.get(room.id).push({ ...event, roomId: room.id, roomName: room.name });
    }
    if (!assignedIds.size) {
      if (hasOnlineSignal(event)) {
        onlineEvents.push({ ...event, roomId: 'online-meetings', roomName: 'Онлайн встречи' });
      } else {
        unassignedCount += 1;
      }
    }
  }

  const rooms = resolver.rooms.map(({ aliases, ...room }) => ({
      ...room,
      events: (roomEvents.get(room.id) || []).sort((a, b) => a.start.localeCompare(b.start)),
    }));
  if (!configuredRooms.length) rooms.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return {
    rooms,
    online: {
      id: 'online-meetings',
      name: 'Все онлайн встречи',
      source: 'online',
      events: onlineEvents.sort((a, b) => a.start.localeCompare(b.start)),
    },
    unassignedCount,
  };
}

module.exports = {
  assignEventsToRooms,
  cleanLocation,
  createRoomResolver,
  hasOnlineSignal,
  locationCandidates,
  readConfiguredRooms,
  roomId,
  normalizedLocationKey,
};

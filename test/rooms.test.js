const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assignEventsToRooms,
  locationCandidates,
  normalizedLocationKey,
  roomId,
} = require('../src/main/rooms');

function event(overrides = {}) {
  return {
    id: '1',
    uid: 'uid-1',
    subject: 'Встреча',
    start: '2026-09-11T07:00:00.000Z',
    end: '2026-09-11T08:00:00.000Z',
    location: '',
    resources: [],
    ...overrides,
  };
}

test('locationCandidates removes online meeting suffixes and URLs', () => {
  assert.deepEqual(locationCandidates('Офис (Москва) / Тимс'), ['Офис (Москва)']);
  assert.deepEqual(locationCandidates('Офис(НьюЙорк)/Дистант/Зум'), ['Офис(НьюЙорк)']);
  assert.deepEqual(locationCandidates('Видео/Тимс'), []);
  assert.deepEqual(locationCandidates('https://teams.example.org/meeting'), []);
});

test('room identity ignores casing, whitespace and brackets', () => {
  assert.equal(normalizedLocationKey('Офис (Москва) / Тимс'), normalizedLocationKey('ОФИС(МОСКВА)/ТИМС'));
  assert.equal(roomId('Кабинет № 1'), roomId(' кабинет №1 '));
});

test('assignEventsToRooms applies aliases and keeps configured rooms free', () => {
  const configured = [{ id: 'main', name: 'Большая переговорная', aliases: ['БП', 'Room 1'] }];
  const result = assignEventsToRooms([event({ location: 'БП' })], configured);
  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].id, 'main');
  assert.equal(result.rooms[0].events.length, 1);
  assert.equal(result.online.events.length, 0);
  assert.equal(result.unassignedCount, 0);
});

test('configured room list prevents offices and personal cabinets from becoming rooms', () => {
  const configured = [
    { id: 'moscow', name: 'Москва', aliases: ['Офис (Москва)', 'ЭРС Групп Москва (2 этаж)'] },
    { id: 'magadan', name: 'Магадан', aliases: [] },
    { id: 'new-york', name: 'Нью-Йорк', aliases: ['Офис (НьюЙорк)'] },
  ];
  const result = assignEventsToRooms([
    event({ id: '1', uid: '1', location: 'Офис (Москва) / Тимс' }),
    event({ id: '2', uid: '2', location: 'Кабинет генерального директора' }),
  ], configured);
  assert.equal(result.rooms.length, 3);
  assert.equal(result.rooms.find((room) => room.id === 'moscow').events.length, 1);
  assert.equal(result.rooms.find((room) => room.id === 'magadan').events.length, 0);
  assert.equal(result.online.events.length, 0);
  assert.equal(result.unassignedCount, 1);
  assert.deepEqual(result.rooms.map((room) => room.id), ['moscow', 'magadan', 'new-york']);
});

test('assignEventsToRooms separates online-only meetings from physical rooms', () => {
  const result = assignEventsToRooms([event({ location: 'Microsoft Teams' })], []);
  assert.equal(result.rooms.length, 0);
  assert.equal(result.online.events.length, 1);
  assert.equal(result.unassignedCount, 0);
});

test('a hybrid Teams meeting assigned to a configured room is not duplicated online', () => {
  const configured = [{ id: 'moscow', name: 'Москва', aliases: ['Офис (Москва)'] }];
  const result = assignEventsToRooms([event({ location: 'Офис (Москва) / Тимс' })], configured);
  assert.equal(result.rooms[0].events.length, 1);
  assert.equal(result.online.events.length, 0);
});

test('assignEventsToRooms counts events without a room or online marker as unassigned', () => {
  const result = assignEventsToRooms([event({ location: 'Кабинет сотрудника' })], [
    { id: 'moscow', name: 'Москва', aliases: [] },
  ]);
  assert.equal(result.online.events.length, 0);
  assert.equal(result.unassignedCount, 1);
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingRooms', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testConfig: (config) => ipcRenderer.invoke('config:test', config),
  getSchedule: (range) => ipcRenderer.invoke('schedule:get', range),
  getFirefliesStatus: () => ipcRenderer.invoke('fireflies:get-status'),
  testFireflies: (config) => ipcRenderer.invoke('fireflies:test', config),
  runFirefliesNow: () => ipcRenderer.invoke('fireflies:run-now'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  onFirefliesStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('fireflies:status', handler);
    return () => ipcRenderer.removeListener('fireflies:status', handler);
  },
});

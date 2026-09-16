const { app, BrowserWindow, ipcMain, Menu, nativeTheme, safeStorage, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');
const { ConfigStore, normalizeSettings, validateSettings } = require('./config');
const { EwsCalendarClient } = require('./ews-client');
const { FirefliesMonitor } = require('./fireflies-service');
const { readConfiguredRooms } = require('./rooms');

const UPDATE_REPO_OWNER = 'DudeMSK';
const UPDATE_REPO_NAME = 'service_for_meeting_rooms';
const UPDATE_CHECK_STARTUP_DELAY_MS = 20_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let mainWindow;
let configStore;
let scheduleCache = new Map();
let roomsFilePath;
let firefliesMonitor;
let tray;
let isQuitting = false;
let trayNoticeShown = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

function getClient(override = null) {
  const current = configStore.load();
  const config = override ? normalizeSettings({ ...current, ...override, password: override.password || current.password }) : current;
  const errors = validateSettings(config);
  if (errors.length) throw new Error(errors.join(' '));
  process.env.TZ = config.timeZone;
  return new EwsCalendarClient(config, readConfiguredRooms(roomsFilePath));
}

function validateRange(payload) {
  const start = new Date(payload?.start);
  const end = new Date(payload?.end);
  const duration = end.getTime() - start.getTime();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || duration <= 0) {
    throw new Error('Некорректный период календаря.');
  }
  if (duration > 370 * 24 * 60 * 60 * 1000) throw new Error('Период не может превышать 370 дней.');
  return { start, end };
}

function ensureRoomsFile(appPath, userDataPath) {
  const destination = path.join(userDataPath, 'rooms.json');
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const bundled = path.join(appPath, 'config', 'rooms.json');
    if (fs.existsSync(bundled)) fs.copyFileSync(bundled, destination);
    else fs.writeFileSync(destination, '[]\n');
  }
  return destination;
}

function configureAutoUpdater() {
  const config = configStore.load();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_REPO_OWNER,
    repo: UPDATE_REPO_NAME,
    private: true,
    token: config.updateToken || undefined,
  });
  return Boolean(config.updateToken);
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
}

async function checkForUpdatesInBackground() {
  const hasToken = configureAutoUpdater();
  if (!hasToken) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // Surfaced to the renderer via the autoUpdater 'error' event handled in registerAutoUpdaterEvents();
    // swallowed here only to avoid an unhandled promise rejection for this unattended background check.
  }
}

function scheduleAutoUpdateChecks() {
  setTimeout(checkForUpdatesInBackground, UPDATE_CHECK_STARTUP_DELAY_MS);
  setInterval(checkForUpdatesInBackground, UPDATE_CHECK_INTERVAL_MS);
}

function registerAutoUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ type: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ type: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ type: 'not-available' }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus({ type: 'progress', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ type: 'downloaded', version: info.version }));
  autoUpdater.on('error', (error) => sendUpdateStatus({ type: 'error', message: error?.message || String(error) }));
}

function createWindow() {
  const mainTheme = configStore.publicConfig().mainTheme;
  const useDarkBackground = mainTheme === 'dark' || (mainTheme === 'system' && nativeTheme.shouldUseDarkColors);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: useDarkBackground ? '#111714' : '#f5f6f3',
    show: false,
    title: 'ЭРС групп | просмотр занятости переговорных',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('close', (event) => {
    const config = configStore.load();
    if (isQuitting || !config.firefliesEnabled || !config.firefliesApiKey) return;
    event.preventDefault();
    mainWindow.hide();
    if (tray && !trayNoticeShown) {
      tray.displayBalloon({
        title: 'ЭРС групп',
        content: 'Окно скрыто, мониторинг Fireflies продолжает работать. Для полного выхода используйте меню значка в трее.',
      });
      trayNoticeShown = true;
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function syncTray() {
  const config = configStore.load();
  const needed = config.firefliesEnabled && Boolean(config.firefliesApiKey);
  if (!needed && tray) {
    tray.destroy();
    tray = null;
    return;
  }
  if (!needed || tray) return;
  tray = new Tray(path.join(__dirname, '..', '..', 'assets', 'icon.ico'));
  tray.setToolTip('ЭРС групп | календарь и Fireflies');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
}

function sendFirefliesStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fireflies:status', status);
}

function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('update:check', async () => {
    const hasToken = configureAutoUpdater();
    if (!hasToken) {
      throw new Error('Автообновление не настроено: добавьте токен GitHub (GH_TOKEN) в .env.');
    }
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      sendUpdateStatus({ type: 'not-packaged' });
    }
  });

  ipcMain.handle('update:download', async () => {
    await autoUpdater.downloadUpdate();
  });

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('config:get', () => ({ ...configStore.publicConfig(), roomsFilePath }));

  ipcMain.handle('config:save', (_event, input) => {
    const result = configStore.save(input || {});
    scheduleCache.clear();
    syncTray();
    firefliesMonitor?.reconfigure();
    return { ...result, roomsFilePath };
  });

  ipcMain.handle('config:test', async (_event, input) => getClient(input || {}).testConnection());

  ipcMain.handle('schedule:get', async (_event, payload) => {
    const { start, end } = validateRange(payload);
    const config = configStore.load();
    const ttl = Math.max(30_000, config.refreshMinutes * 60_000);
    const key = `${start.toISOString()}|${end.toISOString()}`;
    const cached = scheduleCache.get(key);
    if (!payload?.force && cached && Date.now() - cached.timestamp < ttl) return { ...cached.value, cached: true };
    const value = await getClient().getSchedule(start, end);
    scheduleCache.set(key, { timestamp: Date.now(), value });
    if (scheduleCache.size > 12) scheduleCache.delete(scheduleCache.keys().next().value);
    return { ...value, cached: false };
  });

  ipcMain.handle('fireflies:get-status', () => firefliesMonitor.getStatus());
  ipcMain.handle('fireflies:test', (_event, input) => firefliesMonitor.testApi(input?.apiKey));
  ipcMain.handle('fireflies:run-now', () => firefliesMonitor.runNow());
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  const appPath = app.getAppPath();
  const userDataPath = app.getPath('userData');
  configStore = new ConfigStore({ appPath, userDataPath, safeStorage });
  configStore.persistEnvironmentIfNeeded();
  roomsFilePath = ensureRoomsFile(appPath, userDataPath);
  const firefliesStatePath = path.join(userDataPath, 'fireflies-state.json');
  const localAppData = process.env.LOCALAPPDATA || '';
  const legacyDirectories = [
    path.resolve(appPath, '..', 'lancloud-fireflies-bridge'),
    localAppData ? path.join(localAppData, 'Programs', 'LanCloud Fireflies Bridge') : '',
  ].filter(Boolean);
  try {
    configStore.migrateLegacyFireflies({
      envPaths: legacyDirectories.map((directory) => path.join(directory, '.env')),
      statePaths: legacyDirectories.map((directory) => path.join(directory, 'processed_meetings.json')),
      destinationStatePath: firefliesStatePath,
    });
  } catch {
    // Migration is best-effort. The Fireflies tab remains available for manual setup.
  }
  firefliesMonitor = new FirefliesMonitor({
    configStore,
    createEwsClient: () => getClient(),
    statePath: firefliesStatePath,
    onStatus: sendFirefliesStatus,
  });
  registerIpc();
  registerAutoUpdaterEvents();
  createWindow();
  syncTray();
  firefliesMonitor.start();
  scheduleAutoUpdateChecks();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (hasSingleInstanceLock) showMainWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  firefliesMonitor?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

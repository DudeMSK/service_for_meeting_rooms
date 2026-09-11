const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const DEFAULTS = Object.freeze({
  auth: 'ntlm',
  ewsPath: '/EWS/Exchange.asmx',
  timeZone: 'Europe/Moscow',
  refreshMinutes: 5,
  mainTheme: 'system',
  mainAccent: 'green',
  sidebarTheme: 'dark',
  sidebarAccent: 'green',
});

function splitMailboxes(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[;,\n]/);
  return [...new Set(input.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function normalizeServer(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/^https?:\/\//i, '').split('/')[0];
}

function normalizeSettings(input = {}) {
  const refresh = Number.parseInt(input.refreshMinutes, 10);
  const legacyTheme = input.theme;
  const legacyAccent = input.accent;
  const requestedMainTheme = input.mainTheme || legacyTheme;
  const requestedMainAccent = input.mainAccent || legacyAccent;
  const requestedSidebarAccent = input.sidebarAccent || legacyAccent;
  const mainTheme = ['system', 'light', 'dark'].includes(requestedMainTheme) ? requestedMainTheme : DEFAULTS.mainTheme;
  const mainAccent = ['green', 'blue', 'violet', 'orange'].includes(requestedMainAccent) ? requestedMainAccent : DEFAULTS.mainAccent;
  const sidebarTheme = ['match-main', 'light', 'dark'].includes(input.sidebarTheme) ? input.sidebarTheme : DEFAULTS.sidebarTheme;
  const sidebarAccent = ['green', 'blue', 'violet', 'orange'].includes(requestedSidebarAccent) ? requestedSidebarAccent : DEFAULTS.sidebarAccent;
  return {
    email: String(input.email || '').trim().toLowerCase(),
    username: String(input.username || '').trim(),
    password: String(input.password || ''),
    server: normalizeServer(input.server),
    ewsPath: String(input.ewsPath || DEFAULTS.ewsPath).trim() || DEFAULTS.ewsPath,
    auth: String(input.auth || DEFAULTS.auth).toLowerCase() === 'basic' ? 'basic' : 'ntlm',
    timeZone: String(input.timeZone || DEFAULTS.timeZone).trim() || DEFAULTS.timeZone,
    refreshMinutes: Number.isFinite(refresh) ? Math.min(60, Math.max(1, refresh)) : DEFAULTS.refreshMinutes,
    mailboxes: splitMailboxes(input.mailboxes),
    mainTheme,
    mainAccent,
    sidebarTheme,
    sidebarAccent,
    updateToken: String(input.updateToken || ''),
  };
}

function validateSettings(config) {
  const errors = [];
  if (!config.email || !config.email.includes('@')) errors.push('Укажите EWS_EMAIL.');
  if (!config.username) errors.push('Укажите EWS_USERNAME.');
  if (!config.password) errors.push('Укажите EWS_PASSWORD.');
  if (!config.server || !config.server.includes('.')) errors.push('Укажите адрес EWS-сервера.');
  if (!config.mailboxes.length) errors.push('Добавьте хотя бы один календарь.');
  return errors;
}

function readEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return dotenv.parse(fs.readFileSync(filePath));
  } catch {
    return {};
  }
}

class ConfigStore {
  constructor({ appPath, userDataPath, safeStorage }) {
    this.appPath = appPath;
    this.userDataPath = userDataPath;
    this.safeStorage = safeStorage;
    this.settingsPath = path.join(userDataPath, 'settings.json');
    this.env = this.#readEnvironment();
  }

  #readEnvironment() {
    const candidates = [
      path.join(process.cwd(), '.env'),
      path.join(path.dirname(process.execPath), '.env'),
      path.join(this.appPath, '.env'),
    ];
    const fromFile = candidates.reduce((result, candidate) => ({ ...result, ...readEnvFile(candidate) }), {});
    return { ...fromFile, ...process.env };
  }

  #readStored() {
    try {
      if (!fs.existsSync(this.settingsPath)) return {};
      const stored = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      let password = '';
      if (stored.passwordEncrypted && this.safeStorage.isEncryptionAvailable()) {
        password = this.safeStorage.decryptString(Buffer.from(stored.passwordEncrypted, 'base64'));
      }
      const result = { ...stored, password };
      if (stored.updateTokenEncrypted && this.safeStorage.isEncryptionAvailable()) {
        result.updateToken = this.safeStorage.decryptString(Buffer.from(stored.updateTokenEncrypted, 'base64'));
      }
      return result;
    } catch {
      return {};
    }
  }

  load() {
    const envSettings = {
      email: this.env.EWS_EMAIL,
      username: this.env.EWS_USERNAME,
      password: this.env.EWS_PASSWORD,
      server: this.env.EWS_SERVER,
      ewsPath: this.env.EWS_PATH,
      auth: this.env.EWS_AUTH,
      timeZone: this.env.TZ,
      refreshMinutes: this.env.REFRESH_MINUTES,
      mailboxes: this.env.EWS_MAILBOXES,
      updateToken: this.env.GH_TOKEN,
    };
    const stored = this.#readStored();
    const merged = normalizeSettings({ ...envSettings, ...stored });
    merged.source = Object.keys(stored).length ? 'saved' : 'environment';
    return merged;
  }

  publicConfig() {
    const config = this.load();
    return {
      email: config.email,
      username: config.username,
      server: config.server,
      ewsPath: config.ewsPath,
      auth: config.auth,
      timeZone: config.timeZone,
      refreshMinutes: config.refreshMinutes,
      mailboxes: config.mailboxes,
      mainTheme: config.mainTheme,
      mainAccent: config.mainAccent,
      sidebarTheme: config.sidebarTheme,
      sidebarAccent: config.sidebarAccent,
      configured: validateSettings(config).length === 0,
      hasPassword: Boolean(config.password),
      source: config.source,
    };
  }

  persistEnvironmentIfNeeded() {
    if (fs.existsSync(this.settingsPath)) return false;
    const config = this.load();
    if (config.source !== 'environment' || validateSettings(config).length) return false;
    this.save(config);
    return true;
  }

  save(input) {
    const current = this.load();
    const config = normalizeSettings({
      ...current,
      ...input,
      password: input.password || current.password,
      updateToken: input.updateToken || current.updateToken,
    });
    const errors = validateSettings(config);
    if (errors.length) throw new Error(errors.join(' '));
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows не предоставил защищенное хранилище для пароля. Используйте локальный файл .env.');
    }
    fs.mkdirSync(this.userDataPath, { recursive: true });
    const passwordEncrypted = this.safeStorage.encryptString(config.password).toString('base64');
    const stored = { ...config, passwordEncrypted };
    if (config.updateToken) {
      stored.updateTokenEncrypted = this.safeStorage.encryptString(config.updateToken).toString('base64');
    }
    delete stored.password;
    delete stored.updateToken;
    delete stored.source;
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    return this.publicConfig();
  }
}

module.exports = {
  ConfigStore,
  normalizeServer,
  normalizeSettings,
  splitMailboxes,
  validateSettings,
};

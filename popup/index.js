const STORAGE_TYPES = {
  localStorage: 'localStorage',
  sessionStorage: 'sessionStorage',
  cookie: 'cookie',
};

const DEFAULT_STORAGE_TYPE = STORAGE_TYPES.localStorage;
const LAST_TYPE_STORAGE = 'last-storage-type';
/** 旧版共用字段，仅用于迁移 */
const LEGACY_LAST_VALUE_STORAGE = 'last-storage-value';
const AUTO_READ_SETTING = 'setting-auto-read';
const HISTORY_LIMIT = 10;
const SUGGEST_LIMIT = 8;
const DIFF_PREVIEW_LIMIT = 240;
/** Chrome 插件 popup 高度实际上限 */
const CHROME_POPUP_HEIGHT_LIMIT = 600;
/** 值输入框最大高度（超出内部滚动） */
const VALUE_INPUT_MAX_HEIGHT = 280;
const VALUE_INPUT_MIN_HEIGHT = 100;

const BLOCKED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'brave://',
  'opera://',
  'vivaldi://',
  'chrome-search://',
  'chrome-devtools://',
];

const storageKeyInput = document.getElementById('storageKey');
const valueInput = document.getElementById('valueInput');
const readBtn = document.getElementById('readBtn');
const writeBtn = document.getElementById('writeBtn');
const deleteBtn = document.getElementById('deleteBtn');
const copyBtn = document.getElementById('copyBtn');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const clearKeyBtn = document.getElementById('clearKeyBtn');
const formatJsonBtn = document.getElementById('formatJsonBtn');
const compressJsonBtn = document.getElementById('compressJsonBtn');
const browseKeysBtn = document.getElementById('browseKeysBtn');
const routeSectionEl = document.getElementById('routeSection');
const routeToggleBtn = document.getElementById('routeToggleBtn');
const routeInfoEl = document.getElementById('routeInfo');
const statusTextEl = document.getElementById('statusText');
const storageTypeTabsEl = document.getElementById('storageTypeTabs');
const historyPanelEl = document.getElementById('historyPanel');
const historyRowEl = document.getElementById('historyRow');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const cookieOptionsEl = document.getElementById('cookieOptions');
const cookiePathInput = document.getElementById('cookiePath');
const cookieMaxAgeInput = document.getElementById('cookieMaxAge');
const cookieDomainInput = document.getElementById('cookieDomain');
const cookieSameSiteSelect = document.getElementById('cookieSameSite');
const cookieSecureCheckbox = document.getElementById('cookieSecure');
const autoReadToggle = document.getElementById('autoReadToggle');
const keySuggestListEl = document.getElementById('keySuggestList');
const keysPanelEl = document.getElementById('keysPanel');
const keysFilterInput = document.getElementById('keysFilterInput');
const keysListEl = document.getElementById('keysList');
const keysEmptyTipEl = document.getElementById('keysEmptyTip');
const refreshKeysBtn = document.getElementById('refreshKeysBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFileInput = document.getElementById('importFileInput');
const valueByteMetaEl = document.getElementById('valueByteMeta');
const valueJsonMetaEl = document.getElementById('valueJsonMeta');
const confirmDialog = document.getElementById('confirmDialog');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmBodyEl = document.getElementById('confirmBody');
const confirmOkBtn = document.getElementById('confirmOkBtn');

/** @type {string} */
let currentStorageType = DEFAULT_STORAGE_TYPE;
/** 读写/删除互斥锁 */
let isBusy = false;
/** @type {string[]} */
let historyKeyCache = [];
/** @type {string[]} */
let pageKeyCache = [];
/** @type {Record<string, string>} */
let pageEntriesCache = {};
/** @type {Array<{ key: string, source: string }>} */
let suggestItems = [];
let suggestActiveIndex = -1;
let suggestBlurTimer = null;

/**
 * 获取某存储类型最近一次 key 的缓存字段
 * @param {string} storageType
 * @returns {string}
 */
function getLastKeyField(storageType) {
  return `last-key:${storageType}`;
}

/**
 * 获取某存储类型历史 key 列表的缓存字段
 * @param {string} storageType
 * @returns {string}
 */
function getHistoryField(storageType) {
  return `key-history:${storageType}`;
}

/**
 * 获取某存储类型最近一次 value 的缓存字段
 * @param {string} storageType
 * @returns {string}
 */
function getLastValueField(storageType) {
  return `last-storage-value:${storageType}`;
}

/**
 * 在页面上下文中按类型读取
 * @param {string} storageType
 * @param {string} key
 */
function readPageStorage(storageType, key) {
  const routeInfo = {
    href: window.location.href,
    hash: window.location.hash,
    pathname: window.location.pathname,
    origin: window.location.origin,
  };

  function getCookieValue(cookieKeyName) {
    const pairs = document.cookie ? document.cookie.split('; ') : [];
    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      const cookieKey = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
      const cookieValue = equalIndex >= 0 ? pair.slice(equalIndex + 1) : '';
      let decodedKey = cookieKey;
      try {
        decodedKey = decodeURIComponent(cookieKey);
      } catch {
        // 保持原 key
      }
      if (decodedKey === cookieKeyName) {
        try {
          return decodeURIComponent(cookieValue);
        } catch {
          return cookieValue;
        }
      }
    }
    return null;
  }

  if (storageType === 'localStorage') {
    return { ...routeInfo, value: window.localStorage.getItem(key) };
  }

  if (storageType === 'sessionStorage') {
    return { ...routeInfo, value: window.sessionStorage.getItem(key) };
  }

  return { ...routeInfo, value: getCookieValue(key) };
}

/**
 * 列出页面某类型全部 key 与条目
 * @param {string} storageType
 */
function listPageStorageKeys(storageType) {
  const routeInfo = {
    href: window.location.href,
    hash: window.location.hash,
    pathname: window.location.pathname,
    origin: window.location.origin,
  };

  /** @type {Record<string, string>} */
  const entries = {};

  if (storageType === 'localStorage') {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key != null) {
        entries[key] = window.localStorage.getItem(key) ?? '';
      }
    }
  } else if (storageType === 'sessionStorage') {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key != null) {
        entries[key] = window.sessionStorage.getItem(key) ?? '';
      }
    }
  } else {
    const pairs = document.cookie ? document.cookie.split('; ') : [];
    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      const cookieKey = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
      const cookieValue = equalIndex >= 0 ? pair.slice(equalIndex + 1) : '';
      let decodedKey = cookieKey;
      let decodedValue = cookieValue;
      try {
        decodedKey = decodeURIComponent(cookieKey);
      } catch {
        // 保持原 key
      }
      try {
        decodedValue = decodeURIComponent(cookieValue);
      } catch {
        // 保持原 value
      }
      if (decodedKey) {
        entries[decodedKey] = decodedValue;
      }
    }
  }

  const keys = Object.keys(entries).sort((left, right) => left.localeCompare(right));
  return { ...routeInfo, keys, entries };
}

/**
 * 批量写入页面存储
 * @param {string} storageType
 * @param {Record<string, string>} entries
 * @param {{ path?: string, maxAge?: number | null, domain?: string, secure?: boolean, sameSite?: string }} [cookieOptions]
 */
function writePageStorageBatch(storageType, entries, cookieOptions = {}) {
  const routeInfo = {
    href: window.location.href,
    hash: window.location.hash,
    pathname: window.location.pathname,
    origin: window.location.origin,
  };

  function getCookieValue(cookieKeyName) {
    const pairs = document.cookie ? document.cookie.split('; ') : [];
    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      const cookieKey = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
      const cookieValue = equalIndex >= 0 ? pair.slice(equalIndex + 1) : '';
      let decodedKey = cookieKey;
      try {
        decodedKey = decodeURIComponent(cookieKey);
      } catch {
        // 保持原 key
      }
      if (decodedKey === cookieKeyName) {
        try {
          return decodeURIComponent(cookieValue);
        } catch {
          return cookieValue;
        }
      }
    }
    return null;
  }

  let successCount = 0;
  let failCount = 0;
  const entryList = Object.entries(entries || {});

  for (const [key, rawValue] of entryList) {
    const value = rawValue == null ? '' : String(rawValue);
    try {
      if (storageType === 'localStorage') {
        window.localStorage.setItem(key, value);
        if (window.localStorage.getItem(key) === value) {
          successCount += 1;
        } else {
          failCount += 1;
        }
      } else if (storageType === 'sessionStorage') {
        window.sessionStorage.setItem(key, value);
        if (window.sessionStorage.getItem(key) === value) {
          successCount += 1;
        } else {
          failCount += 1;
        }
      } else {
        const path = cookieOptions.path || '/';
        const domain = typeof cookieOptions.domain === 'string' ? cookieOptions.domain.trim() : '';
        let sameSite = typeof cookieOptions.sameSite === 'string' ? cookieOptions.sameSite : '';
        let secure = Boolean(cookieOptions.secure);
        if (sameSite === 'None') {
          secure = true;
        }
        const parts = [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`, `path=${path}`];
        if (domain) {
          parts.push(`domain=${domain}`);
        }
        if (
          cookieOptions.maxAge !== null &&
          cookieOptions.maxAge !== undefined &&
          Number.isFinite(cookieOptions.maxAge)
        ) {
          parts.push(`Max-Age=${Math.floor(cookieOptions.maxAge)}`);
        }
        if (sameSite) {
          parts.push(`SameSite=${sameSite}`);
        }
        if (secure) {
          parts.push('Secure');
        }
        document.cookie = parts.join('; ');
        if (getCookieValue(key) === value) {
          successCount += 1;
        } else {
          failCount += 1;
        }
      }
    } catch {
      failCount += 1;
    }
  }

  return { ...routeInfo, successCount, failCount, total: entryList.length };
}

/**
 * 在页面上下文中按类型写入
 * @param {string} storageType
 * @param {string} key
 * @param {string} value
 * @param {{ path?: string, maxAge?: number | null, domain?: string, secure?: boolean, sameSite?: string }} [cookieOptions]
 */
function writePageStorage(storageType, key, value, cookieOptions = {}) {
  const routeInfo = {
    href: window.location.href,
    hash: window.location.hash,
    pathname: window.location.pathname,
    origin: window.location.origin,
  };

  function getCookieValue(cookieKeyName) {
    const pairs = document.cookie ? document.cookie.split('; ') : [];
    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      const cookieKey = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
      const cookieValue = equalIndex >= 0 ? pair.slice(equalIndex + 1) : '';
      let decodedKey = cookieKey;
      try {
        decodedKey = decodeURIComponent(cookieKey);
      } catch {
        // 保持原 key
      }
      if (decodedKey === cookieKeyName) {
        try {
          return decodeURIComponent(cookieValue);
        } catch {
          return cookieValue;
        }
      }
    }
    return null;
  }

  if (storageType === 'localStorage') {
    window.localStorage.setItem(key, value);
    const readValue = window.localStorage.getItem(key);
    return { ...routeInfo, value: readValue, success: readValue === value };
  }

  if (storageType === 'sessionStorage') {
    window.sessionStorage.setItem(key, value);
    const readValue = window.sessionStorage.getItem(key);
    return { ...routeInfo, value: readValue, success: readValue === value };
  }

  const path = cookieOptions.path || '/';
  const domain = typeof cookieOptions.domain === 'string' ? cookieOptions.domain.trim() : '';
  let sameSite = typeof cookieOptions.sameSite === 'string' ? cookieOptions.sameSite : '';
  let secure = Boolean(cookieOptions.secure);
  if (sameSite === 'None') {
    secure = true;
  }

  const parts = [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`, `path=${path}`];
  if (domain) {
    parts.push(`domain=${domain}`);
  }
  if (cookieOptions.maxAge !== null && cookieOptions.maxAge !== undefined && Number.isFinite(cookieOptions.maxAge)) {
    parts.push(`Max-Age=${Math.floor(cookieOptions.maxAge)}`);
  }
  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }
  if (secure) {
    parts.push('Secure');
  }

  document.cookie = parts.join('; ');
  const readValue = getCookieValue(key);
  return {
    ...routeInfo,
    value: readValue,
    success: readValue === value,
    cookieMeta: { path, domain, secure, sameSite, maxAge: cookieOptions.maxAge ?? null },
  };
}

/**
 * 在页面上下文中按类型删除 key
 * @param {string} storageType
 * @param {string} key
 * @param {{ path?: string, domain?: string }} [cookieOptions]
 */
function deletePageStorage(storageType, key, cookieOptions = {}) {
  const routeInfo = {
    href: window.location.href,
    hash: window.location.hash,
    pathname: window.location.pathname,
    origin: window.location.origin,
  };

  function getCookieValue(cookieKeyName) {
    const pairs = document.cookie ? document.cookie.split('; ') : [];
    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      const cookieKey = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
      const cookieValue = equalIndex >= 0 ? pair.slice(equalIndex + 1) : '';
      let decodedKey = cookieKey;
      try {
        decodedKey = decodeURIComponent(cookieKey);
      } catch {
        // 保持原 key
      }
      if (decodedKey === cookieKeyName) {
        try {
          return decodeURIComponent(cookieValue);
        } catch {
          return cookieValue;
        }
      }
    }
    return null;
  }

  if (storageType === 'localStorage') {
    window.localStorage.removeItem(key);
    return { ...routeInfo, success: window.localStorage.getItem(key) === null };
  }

  if (storageType === 'sessionStorage') {
    window.sessionStorage.removeItem(key);
    return { ...routeInfo, success: window.sessionStorage.getItem(key) === null };
  }

  const path = cookieOptions.path || '/';
  const domain = typeof cookieOptions.domain === 'string' ? cookieOptions.domain.trim() : '';
  const parts = [`${encodeURIComponent(key)}=`, `path=${path}`, 'Max-Age=0'];
  if (domain) {
    parts.push(`domain=${domain}`);
  }
  document.cookie = parts.join('; ');

  return { ...routeInfo, success: getCookieValue(key) === null };
}

/**
 * 获取当前激活标签页
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error('未找到当前激活标签页');
  }
  return tab;
}

/**
 * 校验当前标签页是否允许注入脚本
 * @param {chrome.tabs.Tab} tab
 */
function assertInjectableTab(tab) {
  if (!tab.url) {
    throw new Error('当前页面不支持读写存储（系统页/扩展页）');
  }

  if (BLOCKED_URL_PREFIXES.some((prefix) => tab.url.startsWith(prefix))) {
    throw new Error('当前页面不支持读写存储（系统页/扩展页）');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(tab.url);
  } catch {
    throw new Error('当前页面不支持读写存储（无效地址）');
  }

  const isChromeWebStore =
    parsedUrl.hostname === 'chrome.google.com' && parsedUrl.pathname.startsWith('/webstore');
  const isEdgeAddons = parsedUrl.hostname === 'microsoftedge.microsoft.com';
  if (isChromeWebStore || isEdgeAddons) {
    throw new Error('当前页面不支持读写存储（应用商店页）');
  }
}

/**
 * 在指定标签页执行函数并返回结果
 * @template T
 * @param {number} tabId
 * @param {(...args: any[]) => T} func
 * @param {any[]} args
 * @returns {Promise<T>}
 */
async function executeInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  if (!results || !results[0]) {
    throw new Error('脚本注入失败，请刷新页面后重试');
  }

  if (results[0].error) {
    throw new Error(results[0].error.message || '页面脚本执行失败');
  }

  return results[0].result;
}

/**
 * 渲染路由信息
 * @param {{ href?: string, hash?: string, pathname?: string, origin?: string }} routeInfo
 */
function renderRouteInfo(routeInfo) {
  if (!routeInfo) {
    routeInfoEl.textContent = '无法获取当前路由';
    return;
  }

  const items = [
    ['Origin', routeInfo.origin || '-'],
    ['Path', routeInfo.pathname || '-'],
    ['Hash', routeInfo.hash || '-'],
    ['Href', routeInfo.href || '-'],
  ];

  routeInfoEl.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="route-item"><span class="route-key">${label}</span><span>${escapeHtml(value)}</span></div>`
    )
    .join('');
}

/**
 * HTML 转义
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 截断预览文案
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function truncateText(text, limit = DIFF_PREVIEW_LIMIT) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…（共 ${text.length} 字符）`;
}

/**
 * 设置状态文案
 * @param {string} text
 * @param {'success' | 'error' | 'empty' | ''} type
 */
function setStatus(text, type = '') {
  statusTextEl.textContent = text;
  statusTextEl.className = `status${type ? ` is-${type}` : ''}`;
}

/**
 * 获取存储类型展示名
 * @param {string} storageType
 * @returns {string}
 */
function getStorageTypeLabel(storageType) {
  if (storageType === STORAGE_TYPES.sessionStorage) {
    return 'sessionStorage';
  }
  if (storageType === STORAGE_TYPES.cookie) {
    return 'cookie';
  }
  return 'localStorage';
}

/**
 * 是否开启自动读取
 * @returns {boolean}
 */
function isAutoReadEnabled() {
  return autoReadToggle.checked;
}

/**
 * 同步 Key 输入框清空按钮显隐
 */
function syncClearKeyButton() {
  clearKeyBtn.hidden = !storageKeyInput.value;
}

/**
 * 一键清空 Key 输入框
 */
function handleClearKey() {
  storageKeyInput.value = '';
  syncClearKeyButton();
  hideKeySuggest();
  storageKeyInput.focus();
}

/**
 * 更新 key 输入框占位文案，并同步 Cookie 选项区显隐
 */
function updateKeyPlaceholder() {
  const typeLabel = getStorageTypeLabel(currentStorageType);
  storageKeyInput.placeholder = `输入 ${typeLabel} Key`;
  storageKeyInput.setAttribute('aria-label', `${typeLabel} Key`);
  cookieOptionsEl.hidden = currentStorageType !== STORAGE_TYPES.cookie;
}

/**
 * 读取 Cookie 写入表单选项
 * @returns {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string }}
 */
function getCookieWriteOptions() {
  const path = cookiePathInput.value.trim() || '/';
  const maxAgeRaw = cookieMaxAgeInput.value.trim();
  const maxAgeNumber = maxAgeRaw === '' ? null : Number(maxAgeRaw);
  const maxAge = maxAgeNumber !== null && Number.isFinite(maxAgeNumber) && maxAgeNumber >= 0 ? maxAgeNumber : null;
  const domain = cookieDomainInput.value.trim();
  let sameSite = cookieSameSiteSelect.value;
  let secure = cookieSecureCheckbox.checked;

  if (sameSite === 'None') {
    secure = true;
    cookieSecureCheckbox.checked = true;
  }

  return { path, maxAge, domain, secure, sameSite };
}

/**
 * 设置读写互斥状态
 * @param {boolean} busy
 */
function setBusy(busy) {
  isBusy = busy;
  readBtn.disabled = busy;
  writeBtn.disabled = busy;
  deleteBtn.disabled = busy;
  browseKeysBtn.disabled = busy;
  exportBtn.disabled = busy;
  importBtn.disabled = busy;
  refreshKeysBtn.disabled = busy;
}

/**
 * 更新值区字节数 / JSON 状态
 */
function updateValueMeta() {
  const text = valueInput.value;
  if (!text) {
    valueByteMetaEl.textContent = '';
    valueJsonMetaEl.textContent = '';
    valueJsonMetaEl.className = 'value-json-meta';
    return;
  }

  const byteLength = new TextEncoder().encode(text).length;
  valueByteMetaEl.textContent = `${text.length} 字符 · ${byteLength} 字节`;

  try {
    JSON.parse(text);
    valueJsonMetaEl.textContent = '合法 JSON';
    valueJsonMetaEl.className = 'value-json-meta is-valid';
  } catch {
    valueJsonMetaEl.textContent = '非 JSON';
    valueJsonMetaEl.className = 'value-json-meta is-invalid';
  }
}

/**
 * 弹出确认框
 * @param {{ title: string, body: string, okText?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
function showConfirmDialog(options) {
  const { title, body, okText = '确认', danger = false } = options;
  confirmTitleEl.textContent = title;
  confirmBodyEl.textContent = body;
  confirmOkBtn.textContent = okText;
  confirmOkBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

  return new Promise((resolve) => {
    const onClose = () => {
      confirmDialog.removeEventListener('close', onClose);
      resolve(confirmDialog.returnValue === 'ok');
    };
    confirmDialog.addEventListener('close', onClose);
    confirmDialog.showModal();
  });
}

/**
 * 规范化历史列表
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizeHistoryList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, HISTORY_LIMIT);
}

/**
 * 渲染最近 key 历史
 * @param {string[]} historyList
 */
function renderKeyHistory(historyList) {
  const list = normalizeHistoryList(historyList);
  historyKeyCache = list;

  if (!list.length) {
    historyPanelEl.hidden = true;
    historyRowEl.innerHTML = '';
    historyRowEl.classList.remove('is-scrollable');
    return;
  }

  historyPanelEl.hidden = false;
  historyRowEl.innerHTML = list
    .map((key) => {
      const encodedKey = encodeURIComponent(key);
      const safeLabel = escapeHtml(key);
      return `<div class="history-chip" data-key="${encodedKey}" title="${safeLabel}">
          <button class="history-chip-text" type="button" data-action="select">${safeLabel}</button>
          <button class="history-chip-remove" type="button" data-action="remove" aria-label="删除历史 ${safeLabel}">×</button>
        </div>`;
    })
    .join('');

  requestAnimationFrame(() => {
    const canScroll = historyRowEl.scrollHeight > historyRowEl.clientHeight + 1;
    historyRowEl.classList.toggle('is-scrollable', canScroll);
  });
}

/**
 * 解析历史 chip 上的 key
 * @param {HTMLElement} chip
 * @returns {string}
 */
function getHistoryChipKey(chip) {
  const rawKey = chip.dataset.key || '';
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return rawKey;
  }
}

/**
 * 删除单条历史记录
 * @param {string} key
 */
async function removeKeyHistory(key) {
  const historyField = getHistoryField(currentStorageType);
  const lastKeyField = getLastKeyField(currentStorageType);
  const stored = await chrome.storage.local.get([historyField, lastKeyField]);
  const previousList = normalizeHistoryList(stored[historyField]);
  const nextList = previousList.filter((item) => item !== key);

  const patch = { [historyField]: nextList };
  if (stored[lastKeyField] === key) {
    patch[lastKeyField] = nextList[0] || '';
  }

  await chrome.storage.local.set(patch);
  renderKeyHistory(nextList);

  if (storageKeyInput.value.trim() === key) {
    storageKeyInput.value = nextList[0] || '';
    syncClearKeyButton();
  }
}

/**
 * 一键清空当前类型的历史记录
 */
async function clearAllKeyHistory() {
  const historyField = getHistoryField(currentStorageType);
  const lastKeyField = getLastKeyField(currentStorageType);
  await chrome.storage.local.set({
    [historyField]: [],
    [lastKeyField]: '',
  });
  renderKeyHistory([]);
  setStatus(`已清空 ${getStorageTypeLabel(currentStorageType)} 历史记录`, 'success');
}

/**
 * 读取并渲染当前类型的历史记录
 */
async function loadAndRenderKeyHistory() {
  const historyField = getHistoryField(currentStorageType);
  const lastKeyField = getLastKeyField(currentStorageType);
  const stored = await chrome.storage.local.get([historyField, lastKeyField]);
  let historyList = normalizeHistoryList(stored[historyField]);

  const lastKey = typeof stored[lastKeyField] === 'string' ? stored[lastKeyField].trim() : '';
  if (!historyList.length && lastKey) {
    historyList = [lastKey];
    await chrome.storage.local.set({ [historyField]: historyList });
  }

  renderKeyHistory(historyList);
  return historyList;
}

/**
 * 将 key 写入历史（最近 10 条，去重置顶）
 * @param {string} key
 */
async function pushKeyHistory(key) {
  const historyField = getHistoryField(currentStorageType);
  const stored = await chrome.storage.local.get(historyField);
  const previousList = normalizeHistoryList(stored[historyField]);
  const nextList = [key, ...previousList.filter((item) => item !== key)].slice(0, HISTORY_LIMIT);

  await chrome.storage.local.set({
    [LAST_TYPE_STORAGE]: currentStorageType,
    [getLastKeyField(currentStorageType)]: key,
    [historyField]: nextList,
  });

  renderKeyHistory(nextList);
}

/**
 * 持久化当前类型最近一次 value
 * @param {string} value
 */
async function saveLastValue(value) {
  await chrome.storage.local.set({ [getLastValueField(currentStorageType)]: value });
}

/**
 * 切换路由面板折叠状态
 */
function toggleRouteSection() {
  const isCollapsed = routeSectionEl.classList.toggle('is-collapsed');
  routeToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
}

/**
 * 获取并校验 key
 * @returns {string | null}
 */
function getValidatedKey() {
  const key = storageKeyInput.value.trim();
  if (!key) {
    setStatus('请输入 key', 'error');
    storageKeyInput.focus();
    return null;
  }
  return key;
}

/**
 * 高亮当前存储类型 Tab
 */
function renderActiveTab() {
  const tabButtons = storageTypeTabsEl.querySelectorAll('.tab-item');
  tabButtons.forEach((button) => {
    const isActive = button.dataset.type === currentStorageType;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  });
  updateKeyPlaceholder();
}

/**
 * 刷新页面 key 缓存，并按需渲染列表
 * @param {boolean} [renderList]
 */
async function refreshPageKeys(renderList = false) {
  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);
    const pageData = await executeInTab(tab.id, listPageStorageKeys, [currentStorageType]);
    pageKeyCache = Array.isArray(pageData.keys) ? pageData.keys : [];
    pageEntriesCache =
      pageData.entries && typeof pageData.entries === 'object' ? pageData.entries : {};
    renderRouteInfo(pageData);
    if (renderList || !keysPanelEl.hidden) {
      renderKeysList(keysFilterInput.value.trim());
    }
    return pageData;
  } catch (error) {
    pageKeyCache = [];
    pageEntriesCache = {};
    if (renderList || !keysPanelEl.hidden) {
      renderKeysList(keysFilterInput.value.trim());
    }
    throw error;
  }
}

/**
 * 渲染全部 Key 列表
 * @param {string} [filterText]
 */
function renderKeysList(filterText = '') {
  const keyword = filterText.trim().toLowerCase();
  const filteredKeys = pageKeyCache.filter((key) => !keyword || key.toLowerCase().includes(keyword));

  if (!filteredKeys.length) {
    keysListEl.innerHTML = '';
    keysEmptyTipEl.hidden = false;
    keysEmptyTipEl.textContent = pageKeyCache.length ? '无匹配 key' : '暂无 key';
    return;
  }

  keysEmptyTipEl.hidden = true;
  keysListEl.innerHTML = filteredKeys
    .map((key) => {
      const encodedKey = encodeURIComponent(key);
      const safeLabel = escapeHtml(key);
      return `<button class="keys-item" type="button" data-key="${encodedKey}" title="${safeLabel}">${safeLabel}</button>`;
    })
    .join('');
}

/**
 * 切换全部 Key 面板
 */
async function toggleKeysPanel() {
  if (!keysPanelEl.hidden) {
    keysPanelEl.hidden = true;
    return;
  }

  keysPanelEl.hidden = false;
  keysFilterInput.value = '';
  setStatus('正在加载全部 Key...', '');
  try {
    await refreshPageKeys(true);
    setStatus(`共 ${pageKeyCache.length} 个 key`, pageKeyCache.length ? 'success' : 'empty');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载 Key 失败', 'error');
  }
}

/**
 * 合并联想候选
 * @param {string} query
 * @returns {Array<{ key: string, source: string }>}
 */
function buildSuggestItems(query) {
  const keyword = query.trim().toLowerCase();
  /** @type {Map<string, string>} */
  const merged = new Map();

  historyKeyCache.forEach((key) => {
    if (!keyword || key.toLowerCase().includes(keyword)) {
      merged.set(key, '历史');
    }
  });

  pageKeyCache.forEach((key) => {
    if (!keyword || key.toLowerCase().includes(keyword)) {
      if (!merged.has(key)) {
        merged.set(key, '页面');
      } else if (merged.get(key) === '历史') {
        merged.set(key, '历史/页面');
      }
    }
  });

  return Array.from(merged.entries())
    .map(([key, source]) => ({ key, source }))
    .slice(0, SUGGEST_LIMIT);
}

/**
 * 隐藏联想列表
 */
function hideKeySuggest() {
  suggestItems = [];
  suggestActiveIndex = -1;
  keySuggestListEl.hidden = true;
  keySuggestListEl.innerHTML = '';
}

/**
 * 渲染联想列表
 */
function renderKeySuggest() {
  if (!suggestItems.length) {
    hideKeySuggest();
    return;
  }

  keySuggestListEl.hidden = false;
  keySuggestListEl.innerHTML = suggestItems
    .map((item, index) => {
      const activeClass = index === suggestActiveIndex ? ' is-active' : '';
      return `<li class="key-suggest-item${activeClass}" role="option" data-index="${index}">
        <span>${escapeHtml(item.key)}</span>
        <span class="key-suggest-source">${escapeHtml(item.source)}</span>
      </li>`;
    })
    .join('');
}

/**
 * 刷新并展示联想
 */
async function updateKeySuggest(forceShow = false) {
  const query = storageKeyInput.value;
  if (!forceShow && !query.trim() && document.activeElement !== storageKeyInput) {
    hideKeySuggest();
    return;
  }

  if (!pageKeyCache.length) {
    try {
      await refreshPageKeys(false);
    } catch {
      // 联想失败时仍可用历史
    }
  }

  suggestItems = buildSuggestItems(query);
  suggestActiveIndex = suggestItems.length ? 0 : -1;
  renderKeySuggest();
}

/**
 * 选中联想项
 * @param {number} index
 */
async function selectSuggestItem(index) {
  const item = suggestItems[index];
  if (!item) {
    return;
  }
  hideKeySuggest();
  storageKeyInput.value = item.key;
  syncClearKeyButton();
  await handleRead();
}

/**
 * 切换存储类型
 * @param {string} storageType
 */
async function switchStorageType(storageType) {
  if (!Object.values(STORAGE_TYPES).includes(storageType) || storageType === currentStorageType || isBusy) {
    return;
  }

  const currentKey = storageKeyInput.value.trim();
  if (currentKey) {
    await pushKeyHistory(currentKey);
  }

  currentStorageType = storageType;
  renderActiveTab();
  hideKeySuggest();
  pageKeyCache = [];
  pageEntriesCache = {};

  const historyList = await loadAndRenderKeyHistory();
  storageKeyInput.value = historyList[0] || '';
  syncClearKeyButton();
  await chrome.storage.local.set({ [LAST_TYPE_STORAGE]: storageType });

  if (!keysPanelEl.hidden) {
    try {
      await refreshPageKeys(true);
    } catch {
      renderKeysList(keysFilterInput.value.trim());
    }
  }

  if (storageKeyInput.value.trim() && isAutoReadEnabled()) {
    await handleRead();
  } else {
    const lastValueField = getLastValueField(storageType);
    const stored = await chrome.storage.local.get(lastValueField);
    valueInput.value = typeof stored[lastValueField] === 'string' ? stored[lastValueField] : '';
    autoResizeValueInput();
    updateValueMeta();
    setStatus(storageKeyInput.value.trim() ? '已关闭自动读取，可手动点击读取' : '请输入 key 后读取', '');
  }
}

/**
 * 点击历史 / 列表 key 填充并读取
 * @param {string} key
 */
async function handleSelectHistoryKey(key) {
  if (isBusy) {
    return;
  }
  hideKeySuggest();
  storageKeyInput.value = key;
  syncClearKeyButton();
  await handleRead();
}

/**
 * 读取当前页面指定 key
 */
async function handleRead() {
  if (isBusy) {
    return;
  }

  const key = getValidatedKey();
  if (!key) {
    return;
  }

  setBusy(true);
  setStatus('读取中...');

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    const pageData = await executeInTab(tab.id, readPageStorage, [currentStorageType, key]);
    renderRouteInfo(pageData);
    await pushKeyHistory(key);

    if (pageData.value === null) {
      valueInput.value = '';
      autoResizeValueInput();
      updateValueMeta();
      const tip =
        currentStorageType === STORAGE_TYPES.cookie
          ? `cookie "${key}" 不存在（HttpOnly cookie 无法通过脚本读取）`
          : `key "${key}" 不存在`;
      setStatus(tip, 'empty');
    } else {
      valueInput.value = pageData.value;
      autoResizeValueInput();
      updateValueMeta();
      await saveLastValue(pageData.value);
      const byteLength = new TextEncoder().encode(pageData.value).length;
      setStatus(
        `读取成功（${getStorageTypeLabel(currentStorageType)}），${pageData.value.length} 字符 · ${byteLength} 字节`,
        'success'
      );
    }

    if (!keysPanelEl.hidden) {
      refreshPageKeys(true).catch(() => {});
    } else {
      refreshPageKeys(false).catch(() => {});
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '读取失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 将文本框中的值写入当前页面存储
 */
async function handleWrite() {
  if (isBusy) {
    return;
  }

  const key = getValidatedKey();
  if (!key) {
    return;
  }

  const value = valueInput.value;
  if (!value) {
    setStatus('请先粘贴或输入要写入的值', 'error');
    valueInput.focus();
    return;
  }

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    const existingData = await executeInTab(tab.id, readPageStorage, [currentStorageType, key]);
    if (existingData.value !== null && existingData.value !== value) {
      const confirmed = await showConfirmDialog({
        title: `确认覆盖写入「${key}」？`,
        body: `旧值（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}\n\n新值（${value.length} 字符）：\n${truncateText(value)}`,
        okText: '确认覆盖',
        danger: true,
      });
      if (!confirmed) {
        setStatus('已取消写入', 'empty');
        return;
      }
    } else if (existingData.value === null) {
      const confirmed = await showConfirmDialog({
        title: `确认新建写入「${key}」？`,
        body: `将写入新值（${value.length} 字符）：\n${truncateText(value)}`,
        okText: '确认写入',
      });
      if (!confirmed) {
        setStatus('已取消写入', 'empty');
        return;
      }
    }

    setBusy(true);
    setStatus('写入中...');

    const cookieOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : undefined;
    const pageData = await executeInTab(tab.id, writePageStorage, [
      currentStorageType,
      key,
      value,
      cookieOptions,
    ]);
    renderRouteInfo(pageData);
    valueInput.value = pageData.value ?? value;
    autoResizeValueInput();
    updateValueMeta();
    await pushKeyHistory(key);
    await saveLastValue(value);

    if (!pageData.success) {
      const failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '写入后回读不一致（可能被浏览器拒绝：Secure/SameSite/Domain/大小限制，或与 HttpOnly 冲突）'
          : '写入后回读不一致，请确认页面是否允许写入';
      setStatus(failTip, 'error');
      return;
    }

    let cookieTip = '';
    if (currentStorageType === STORAGE_TYPES.cookie && cookieOptions) {
      const parts = [`path=${cookieOptions.path}`];
      if (cookieOptions.maxAge !== null) {
        parts.push(`Max-Age=${cookieOptions.maxAge}`);
      } else {
        parts.push('会话 cookie');
      }
      if (cookieOptions.domain) {
        parts.push(`domain=${cookieOptions.domain}`);
      }
      if (cookieOptions.sameSite) {
        parts.push(`SameSite=${cookieOptions.sameSite}`);
      }
      if (cookieOptions.secure) {
        parts.push('Secure');
      }
      cookieTip = `（${parts.join('，')}）`;
    }

    setStatus(
      `写入成功：${getStorageTypeLabel(currentStorageType)} / ${key}（长度 ${value.length}）${cookieTip}`,
      'success'
    );

    if (!keysPanelEl.hidden) {
      refreshPageKeys(true).catch(() => {});
    } else {
      refreshPageKeys(false).catch(() => {});
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '写入失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 删除当前页面指定 key
 */
async function handleDelete() {
  if (isBusy) {
    return;
  }

  const key = getValidatedKey();
  if (!key) {
    return;
  }

  const typeLabel = getStorageTypeLabel(currentStorageType);

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);
    const existingData = await executeInTab(tab.id, readPageStorage, [currentStorageType, key]);

    let body =
      existingData.value === null
        ? `当前读不到「${key}」的值（可能不存在或为 HttpOnly）。仍尝试删除？`
        : `将删除「${key}」当前值（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}`;

    if (currentStorageType === STORAGE_TYPES.cookie) {
      body += '\n\n提示：若删除失败，可尝试调整上方 Path / Domain 后再删。';
    }

    const confirmed = await showConfirmDialog({
      title: `确认删除 ${typeLabel} / ${key}？`,
      body,
      okText: '确认删除',
      danger: true,
    });
    if (!confirmed) {
      setStatus('已取消删除', 'empty');
      return;
    }

    setBusy(true);
    setStatus('删除中...');

    const writeOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : null;
    const cookieOptions = writeOptions
      ? { path: writeOptions.path, domain: writeOptions.domain }
      : undefined;
    const pageData = await executeInTab(tab.id, deletePageStorage, [
      currentStorageType,
      key,
      cookieOptions,
    ]);
    renderRouteInfo(pageData);

    if (!pageData.success) {
      const failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '删除失败：cookie 仍存在。可尝试修改 Path/Domain 后再删；HttpOnly cookie 无法通过脚本删除'
          : '删除失败：key 仍存在';
      setStatus(failTip, 'error');
      return;
    }

    valueInput.value = '';
    autoResizeValueInput();
    updateValueMeta();
    await pushKeyHistory(key);
    await saveLastValue('');
    setStatus(`已删除：${typeLabel} / ${key}`, 'success');

    if (!keysPanelEl.hidden) {
      refreshPageKeys(true).catch(() => {});
    } else {
      refreshPageKeys(false).catch(() => {});
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '删除失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 导出当前类型全部条目
 */
async function handleExport() {
  if (isBusy) {
    return;
  }

  setBusy(true);
  setStatus('导出中...');

  try {
    const pageData = await refreshPageKeys(true);
    const payload = {
      type: currentStorageType,
      exportedAt: new Date().toISOString(),
      origin: pageData.origin || '',
      data: pageData.entries || {},
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `${currentStorageType}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    setStatus(`已导出 ${Object.keys(payload.data).length} 个 key`, 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 解析导入 JSON
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseImportEntries(text) {
  const parsed = JSON.parse(text);
  let rawEntries = parsed;

  if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
    rawEntries = parsed.data;
  }

  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    throw new Error('导入格式无效，需要 { key: value } 或 { data: { key: value } }');
  }

  /** @type {Record<string, string>} */
  const entries = {};
  Object.entries(rawEntries).forEach(([key, value]) => {
    if (typeof key === 'string' && key.trim()) {
      entries[key] = value == null ? '' : String(value);
    }
  });

  if (!Object.keys(entries).length) {
    throw new Error('导入内容为空');
  }

  return entries;
}

/**
 * 导入 JSON 并批量写入
 * @param {File} file
 */
async function handleImportFile(file) {
  if (isBusy) {
    return;
  }

  try {
    const text = await file.text();
    const entries = parseImportEntries(text);
    const keys = Object.keys(entries);
    const preview = keys
      .slice(0, 8)
      .map((key) => `- ${key}`)
      .join('\n');
    const moreTip = keys.length > 8 ? `\n…共 ${keys.length} 个 key` : '';

    const confirmed = await showConfirmDialog({
      title: `确认导入到 ${getStorageTypeLabel(currentStorageType)}？`,
      body: `将写入 / 覆盖以下 key：\n${preview}${moreTip}`,
      okText: '确认导入',
      danger: true,
    });
    if (!confirmed) {
      setStatus('已取消导入', 'empty');
      return;
    }

    setBusy(true);
    setStatus('导入中...');

    const tab = await getActiveTab();
    assertInjectableTab(tab);
    const cookieOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : undefined;
    const result = await executeInTab(tab.id, writePageStorageBatch, [
      currentStorageType,
      entries,
      cookieOptions,
    ]);
    renderRouteInfo(result);
    await refreshPageKeys(true);

    if (result.failCount > 0) {
      setStatus(`导入完成：成功 ${result.successCount}，失败 ${result.failCount}`, 'error');
    } else {
      setStatus(`导入成功：${result.successCount} 个 key`, 'success');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导入失败', 'error');
  } finally {
    setBusy(false);
    importFileInput.value = '';
  }
}

/**
 * 复制文本框内容到剪贴板
 */
async function handleCopy() {
  const text = valueInput.value;
  if (!text) {
    setStatus('没有可复制的内容', 'empty');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    await saveLastValue(text);
    setStatus('已复制到剪贴板', 'success');
  } catch {
    setStatus('复制失败，请手动选中复制', 'error');
  }
}

/**
 * 从剪贴板粘贴到文本框
 */
async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setStatus('剪贴板为空', 'empty');
      return;
    }
    valueInput.value = text;
    autoResizeValueInput();
    updateValueMeta();
    setStatus(`已粘贴，长度 ${text.length}，可点击「写入」`, 'success');
    valueInput.focus();
  } catch {
    setStatus('粘贴失败，请手动 Ctrl/Cmd + V 粘贴到输入框', 'error');
    valueInput.focus();
  }
}

/**
 * 格式化 JSON
 */
function handleFormatJson() {
  const text = valueInput.value.trim();
  if (!text) {
    setStatus('没有可格式化的内容', 'empty');
    return;
  }

  try {
    valueInput.value = JSON.stringify(JSON.parse(text), null, 2);
    autoResizeValueInput();
    updateValueMeta();
    setStatus('已格式化 JSON', 'success');
  } catch {
    setStatus('不是合法 JSON，无法格式化', 'error');
  }
}

/**
 * 压缩 JSON
 */
function handleCompressJson() {
  const text = valueInput.value.trim();
  if (!text) {
    setStatus('没有可压缩的内容', 'empty');
    return;
  }

  try {
    valueInput.value = JSON.stringify(JSON.parse(text));
    autoResizeValueInput();
    updateValueMeta();
    setStatus('已压缩 JSON', 'success');
  } catch {
    setStatus('不是合法 JSON，无法压缩', 'error');
  }
}

/**
 * 值输入框按内容自动撑开高度，超出上限后内部滚动
 */
function autoResizeValueInput() {
  valueInput.style.height = 'auto';
  const contentHeight = Math.max(valueInput.scrollHeight, VALUE_INPUT_MIN_HEIGHT);
  const nextHeight = Math.min(contentHeight, VALUE_INPUT_MAX_HEIGHT);
  valueInput.style.height = `${nextHeight}px`;
  valueInput.style.overflowY = contentHeight > VALUE_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
}

/**
 * 设置弹窗最大高度
 */
function applyPopupMaxHeight() {
  const screenBasedHeight = Math.floor(window.screen.availHeight * 0.8);
  const maxHeight = Math.min(screenBasedHeight, CHROME_POPUP_HEIGHT_LIMIT);
  document.documentElement.style.setProperty('--popup-max-height', `${maxHeight}px`);
}

/**
 * 清空文本框
 */
function handleClear() {
  valueInput.value = '';
  autoResizeValueInput();
  updateValueMeta();
  setStatus('已清空', '');
  valueInput.focus();
}

/**
 * 判断是否按下 Cmd/Ctrl + Enter
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function isSubmitShortcut(event) {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey);
}

/**
 * Tab 左右方向键切换
 * @param {KeyboardEvent} event
 */
function handleTablistKeydown(event) {
  const tabButtons = Array.from(storageTypeTabsEl.querySelectorAll('.tab-item'));
  const currentIndex = tabButtons.findIndex((button) => button.dataset.type === currentStorageType);
  if (currentIndex < 0) {
    return;
  }

  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % tabButtons.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabButtons.length - 1;
  } else {
    return;
  }

  event.preventDefault();
  const nextType = tabButtons[nextIndex].dataset.type;
  if (nextType) {
    tabButtons[nextIndex].focus();
    switchStorageType(nextType);
  }
}

/**
 * 初始化弹窗
 */
async function initPopup() {
  applyPopupMaxHeight();

  const historyFields = Object.values(STORAGE_TYPES).map((type) => getHistoryField(type));
  const lastKeyFields = Object.values(STORAGE_TYPES).map((type) => getLastKeyField(type));
  const lastValueFields = Object.values(STORAGE_TYPES).map((type) => getLastValueField(type));
  const stored = await chrome.storage.local.get([
    LAST_TYPE_STORAGE,
    LEGACY_LAST_VALUE_STORAGE,
    AUTO_READ_SETTING,
    ...historyFields,
    ...lastKeyFields,
    ...lastValueFields,
  ]);

  autoReadToggle.checked = stored[AUTO_READ_SETTING] !== false;

  const savedType = stored[LAST_TYPE_STORAGE];
  currentStorageType = Object.values(STORAGE_TYPES).includes(savedType) ? savedType : DEFAULT_STORAGE_TYPE;
  renderActiveTab();

  const currentLastValueField = getLastValueField(currentStorageType);
  if (
    typeof stored[LEGACY_LAST_VALUE_STORAGE] === 'string' &&
    stored[LEGACY_LAST_VALUE_STORAGE] &&
    !stored[currentLastValueField]
  ) {
    await chrome.storage.local.set({ [currentLastValueField]: stored[LEGACY_LAST_VALUE_STORAGE] });
    stored[currentLastValueField] = stored[LEGACY_LAST_VALUE_STORAGE];
    await chrome.storage.local.remove(LEGACY_LAST_VALUE_STORAGE);
  }

  const historyList = await loadAndRenderKeyHistory();
  storageKeyInput.value = historyList[0] || '';
  syncClearKeyButton();

  if (typeof stored[currentLastValueField] === 'string' && stored[currentLastValueField] && storageKeyInput.value) {
    valueInput.value = stored[currentLastValueField];
  }
  autoResizeValueInput();
  updateValueMeta();

  storageTypeTabsEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const storageType = target.dataset.type;
    if (!storageType) {
      return;
    }
    switchStorageType(storageType);
  });
  storageTypeTabsEl.addEventListener('keydown', handleTablistKeydown);

  clearHistoryBtn.addEventListener('click', clearAllKeyHistory);
  browseKeysBtn.addEventListener('click', toggleKeysPanel);
  refreshKeysBtn.addEventListener('click', async () => {
    setStatus('刷新中...', '');
    try {
      await refreshPageKeys(true);
      setStatus(`共 ${pageKeyCache.length} 个 key`, pageKeyCache.length ? 'success' : 'empty');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '刷新失败', 'error');
    }
  });
  keysFilterInput.addEventListener('input', () => {
    renderKeysList(keysFilterInput.value);
  });
  keysListEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const item = target.closest('.keys-item');
    if (!(item instanceof HTMLElement) || !item.dataset.key) {
      return;
    }
    try {
      handleSelectHistoryKey(decodeURIComponent(item.dataset.key));
    } catch {
      handleSelectHistoryKey(item.dataset.key);
    }
  });

  exportBtn.addEventListener('click', handleExport);
  importBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', () => {
    const file = importFileInput.files && importFileInput.files[0];
    if (file) {
      handleImportFile(file);
    }
  });

  historyRowEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionButton = target.closest('[data-action]');
    if (!(actionButton instanceof HTMLElement)) {
      return;
    }

    const chip = actionButton.closest('.history-chip');
    if (!(chip instanceof HTMLElement)) {
      return;
    }

    const key = getHistoryChipKey(chip);
    if (!key) {
      return;
    }

    if (actionButton.dataset.action === 'remove') {
      event.stopPropagation();
      removeKeyHistory(key);
      return;
    }

    if (actionButton.dataset.action === 'select') {
      handleSelectHistoryKey(key);
    }
  });

  routeToggleBtn.addEventListener('click', toggleRouteSection);
  readBtn.addEventListener('click', handleRead);
  writeBtn.addEventListener('click', handleWrite);
  deleteBtn.addEventListener('click', handleDelete);
  copyBtn.addEventListener('click', handleCopy);
  pasteBtn.addEventListener('click', handlePaste);
  clearBtn.addEventListener('click', handleClear);
  clearKeyBtn.addEventListener('click', handleClearKey);
  formatJsonBtn.addEventListener('click', handleFormatJson);
  compressJsonBtn.addEventListener('click', handleCompressJson);
  valueInput.addEventListener('input', () => {
    autoResizeValueInput();
    updateValueMeta();
  });

  autoReadToggle.addEventListener('change', () => {
    chrome.storage.local.set({ [AUTO_READ_SETTING]: autoReadToggle.checked });
    setStatus(autoReadToggle.checked ? '已开启打开自动读取' : '已关闭打开自动读取', 'success');
  });

  cookieSameSiteSelect.addEventListener('change', () => {
    if (cookieSameSiteSelect.value === 'None') {
      cookieSecureCheckbox.checked = true;
    }
  });

  storageKeyInput.addEventListener('input', () => {
    syncClearKeyButton();
    updateKeySuggest(true);
  });
  storageKeyInput.addEventListener('focus', () => {
    updateKeySuggest(true);
  });
  storageKeyInput.addEventListener('blur', () => {
    suggestBlurTimer = setTimeout(() => {
      hideKeySuggest();
    }, 150);
  });
  keySuggestListEl.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (suggestBlurTimer) {
      clearTimeout(suggestBlurTimer);
      suggestBlurTimer = null;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const item = target.closest('.key-suggest-item');
    if (!(item instanceof HTMLElement)) {
      return;
    }
    const index = Number(item.dataset.index);
    if (Number.isFinite(index)) {
      selectSuggestItem(index);
    }
  });

  storageKeyInput.addEventListener('keydown', (event) => {
    if (!keySuggestListEl.hidden && suggestItems.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        suggestActiveIndex = (suggestActiveIndex + 1) % suggestItems.length;
        renderKeySuggest();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        suggestActiveIndex = (suggestActiveIndex - 1 + suggestItems.length) % suggestItems.length;
        renderKeySuggest();
        return;
      }
      if (event.key === 'Escape') {
        hideKeySuggest();
        return;
      }
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && suggestActiveIndex >= 0) {
        event.preventDefault();
        selectSuggestItem(suggestActiveIndex);
        return;
      }
    }

    if (isSubmitShortcut(event)) {
      event.preventDefault();
      handleWrite();
      return;
    }
    if (event.key === 'Enter') {
      handleRead();
    }
  });

  valueInput.addEventListener('keydown', (event) => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      handleWrite();
    }
  });

  storageKeyInput.addEventListener('change', () => {
    const key = storageKeyInput.value.trim();
    if (key) {
      pushKeyHistory(key);
    }
  });

  refreshPageKeys(false).catch(() => {});

  if (storageKeyInput.value.trim() && isAutoReadEnabled()) {
    await handleRead();
  } else if (storageKeyInput.value.trim()) {
    setStatus('已关闭自动读取，可手动点击读取', '');
  }
}

initPopup();

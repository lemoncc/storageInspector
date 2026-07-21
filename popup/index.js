const STORAGE_TYPES = {
  localStorage: 'localStorage',
  sessionStorage: 'sessionStorage',
  cookie: 'cookie',
};

const DEFAULT_STORAGE_TYPE = STORAGE_TYPES.localStorage;
const LAST_TYPE_STORAGE = 'last-storage-type';
/** 旧版共用字段，仅用于迁移 */
const LEGACY_LAST_VALUE_STORAGE = 'last-storage-value';
const HISTORY_LIMIT = 10;
/** 备选项优先展示的历史条数（按最近使用倒序） */
const HISTORY_SUGGEST_LIMIT = 3;
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
const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
const statusTextEl = document.getElementById('statusText');
const actionStatusTextEl = document.getElementById('actionStatusText');
const STATUS_ZONE = {
  key: 'key',
  action: 'action',
};
const storageTypeTabsEl = document.getElementById('storageTypeTabs');
const historyPanelEl = document.getElementById('historyPanel');
const historyRowEl = document.getElementById('historyRow');
const historyEmptyTipEl = document.getElementById('historyEmptyTip');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const cookieOptionsEl = document.getElementById('cookieOptions');
const cookiePathInput = document.getElementById('cookiePath');
const cookieMaxAgeInput = document.getElementById('cookieMaxAge');
const cookieDomainInput = document.getElementById('cookieDomain');
const cookieSameSiteSelect = document.getElementById('cookieSameSite');
const cookieSecureCheckbox = document.getElementById('cookieSecure');
const cookieHttpOnlyCheckbox = document.getElementById('cookieHttpOnly');
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
/** 历史面板是否展开（默认关闭） */
let isHistoryPanelOpen = false;
/** @type {string[]} */
let historyKeyCache = [];
/** @type {string[]} */
let pageKeyCache = [];
/** @type {Record<string, string>} */
let pageEntriesCache = {};
/** @type {Record<string, chrome.cookies.Cookie>} */
let cookieDetailCache = {};
/**
 * 读取 cookie 时保留的绝对过期时间（unix 秒）
 * Max-Age 留空时写入沿用，避免把「剩余秒数」当 Max-Age 导致过期被缩短
 * @type {number | null}
 */
let cookiePreservedExpirationDate = null;
/** @type {Array<{ key: string, source: string, label?: string, cacheKey?: string }>} */
let suggestItems = [];
let suggestActiveIndex = -1;
let suggestBlurTimer = null;
/** 备选请求序号，避免异步回写互相覆盖 */
let suggestRequestId = 0;
/** 页面 Key 缓存是否可用（联想过滤用，避免每次按键全量拉取） */
let pageKeysCacheReady = false;
/** 页面 Key 缓存拉取时间 */
let pageKeysFetchedAt = 0;
/** 联想防抖定时器 */
let suggestDebounceTimer = null;
/** 联想防抖间隔（毫秒） */
const SUGGEST_DEBOUNCE_MS = 220;
/** 页面 Key 缓存有效期（毫秒） */
const PAGE_KEYS_CACHE_TTL_MS = 30000;

/**
 * 递归格式化还原表：路径 -> 展开前原始字符串
 * @type {Map<string, string>}
 */
let nestedStringRestoreMap = new Map();
/** 是否处于「已递归展开、尚未还原」状态 */
let formatExpandActive = false;
/** 格式化前的整段原文（还原表异常时的保底，避免把展开态写入） */
let preFormatRootText = '';
/**
 * 格式化时的还原表备份（防止写入前还原表被意外清空）
 * @type {Map<string, string> | null}
 */
let formatRestoreMapBackup = null;

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
        const options = cookieOptions || {};
        const path = options.path || '/';
        const domain = typeof options.domain === 'string' ? options.domain.trim() : '';
        let sameSite = typeof options.sameSite === 'string' ? options.sameSite : '';
        let secure = Boolean(options.secure);
        if (sameSite === 'None') {
          secure = true;
        }
        const parts = [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`, `path=${path}`];
        if (domain) {
          parts.push(`domain=${domain}`);
        }
        if (
          options.maxAge !== null &&
          options.maxAge !== undefined &&
          Number.isFinite(options.maxAge)
        ) {
          parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
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

  const options = cookieOptions || {};
  const path = options.path || '/';
  const domain = typeof options.domain === 'string' ? options.domain.trim() : '';
  let sameSite = typeof options.sameSite === 'string' ? options.sameSite : '';
  let secure = Boolean(options.secure);
  if (sameSite === 'None') {
    secure = true;
  }

  const parts = [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`, `path=${path}`];
  if (domain) {
    parts.push(`domain=${domain}`);
  }
  if (options.maxAge !== null && options.maxAge !== undefined && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
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
    cookieMeta: { path, domain, secure, sameSite, maxAge: options.maxAge ?? null },
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

  const options = cookieOptions || {};
  const path = options.path || '/';
  const domain = typeof options.domain === 'string' ? options.domain.trim() : '';
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
  // chrome.scripting.executeScript 的 args 不能包含 undefined（会报 Value is unserializable）
  const serializableArgs = args.map((arg) => (arg === undefined ? null : arg));

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: serializableArgs,
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
 * 从 tab.url 构造路由信息
 * @param {chrome.tabs.Tab} tab
 */
function buildRouteInfoFromTab(tab) {
  try {
    const parsedUrl = new URL(tab.url || '');
    return {
      href: tab.url || '',
      hash: parsedUrl.hash,
      pathname: parsedUrl.pathname,
      origin: parsedUrl.origin,
    };
  } catch {
    return {
      href: tab.url || '',
      hash: '',
      pathname: '',
      origin: '',
    };
  }
}

/**
 * SameSite 表单值 -> chrome.cookies API
 * @param {string} sameSite
 * @returns {chrome.cookies.SameSiteStatus | undefined}
 */
function mapSameSiteToApi(sameSite) {
  if (sameSite === 'Lax') {
    return 'lax';
  }
  if (sameSite === 'Strict') {
    return 'strict';
  }
  if (sameSite === 'None') {
    return 'no_restriction';
  }
  return undefined;
}

/**
 * chrome.cookies SameSite -> 表单值
 * @param {string | undefined} sameSite
 * @returns {string}
 */
function mapSameSiteFromApi(sameSite) {
  if (sameSite === 'lax') {
    return 'Lax';
  }
  if (sameSite === 'strict') {
    return 'Strict';
  }
  if (sameSite === 'no_restriction') {
    return 'None';
  }
  return '';
}

/**
 * 生成 cookie 缓存键（同名不同 Path/Domain 互不覆盖）
 * @param {{ name?: string, path?: string, domain?: string, hostOnly?: boolean }} cookie
 * @returns {string}
 */
function buildCookieCacheKey(cookie) {
  const name = cookie.name || '';
  const path = cookie.path || '/';
  const domainPart = cookie.hostOnly ? '' : String(cookie.domain || '');
  return `${name}\u0001${path}\u0001${domainPart}`;
}

/**
 * 导出用 cookie 序列化
 * @param {chrome.cookies.Cookie} cookie
 * @returns {Record<string, any>}
 */
function serializeCookieForExport(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    domain: cookie.hostOnly ? '' : cookie.domain || '',
    hostOnly: Boolean(cookie.hostOnly),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || '',
    session: Boolean(cookie.session),
    expirationDate:
      cookie.session || !cookie.expirationDate ? null : cookie.expirationDate,
  };
}

/**
 * 规范化导入的 cookie 详情条目
 * @param {any} item
 * @returns {{ name: string, value: string, path: string, domain: string, secure: boolean, httpOnly: boolean, sameSite: string, maxAge: null, expirationDate: number | null } | null}
 */
function normalizeImportedCookieItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) {
    return null;
  }
  const value = item.value == null ? '' : String(item.value);
  const path = typeof item.path === 'string' && item.path.trim() ? item.path.trim() : '/';
  const hostOnly = Boolean(item.hostOnly);
  const domain = hostOnly
    ? ''
    : typeof item.domain === 'string'
      ? item.domain.trim()
      : '';
  const sameSiteRaw = typeof item.sameSite === 'string' ? item.sameSite : '';
  // 兼容 API 小写与表单大写
  const sameSite =
    sameSiteRaw === 'lax' || sameSiteRaw === 'strict' || sameSiteRaw === 'no_restriction'
      ? mapSameSiteFromApi(sameSiteRaw)
      : sameSiteRaw;
  const expirationDate =
    typeof item.expirationDate === 'number' && Number.isFinite(item.expirationDate)
      ? item.expirationDate
      : null;
  const session = item.session === true || expirationDate === null;

  return {
    name,
    value,
    path,
    domain,
    secure: Boolean(item.secure),
    httpOnly: Boolean(item.httpOnly),
    sameSite,
    maxAge: null,
    expirationDate: session ? null : expirationDate,
  };
}

/**
 * 根据 cookie 详情构造可用于 remove/set 的 URL
 * @param {chrome.cookies.Cookie} cookie
 * @param {chrome.tabs.Tab} tab
 * @returns {string}
 */
function buildCookieUrl(cookie, tab) {
  try {
    const tabUrl = new URL(tab.url || 'https://example.com');
    const protocol = cookie.secure ? 'https:' : tabUrl.protocol;
    const rawDomain = cookie.domain || tabUrl.hostname;
    const domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
    const path = cookie.path || '/';
    return `${protocol}//${domain}${path}`;
  } catch {
    return tab.url || '';
  }
}

/**
 * 将 cookie 详情回填到表单
 * @param {chrome.cookies.Cookie} cookie
 */
function applyCookieDetailsToForm(cookie) {
  cookiePathInput.value = cookie.path || '/';
  cookieDomainInput.value = cookie.hostOnly ? '' : cookie.domain || '';
  cookieSecureCheckbox.checked = Boolean(cookie.secure);
  cookieHttpOnlyCheckbox.checked = Boolean(cookie.httpOnly);
  cookieSameSiteSelect.value = mapSameSiteFromApi(cookie.sameSite);
  if (cookie.session || !cookie.expirationDate) {
    cookiePreservedExpirationDate = null;
    cookieMaxAgeInput.value = '';
    cookieMaxAgeInput.placeholder = '秒，空=会话';
    cookieMaxAgeInput.title = '';
  } else {
    // 保留绝对过期时间；Max-Age 留空表示「保持原过期」，避免剩余秒数回填后越写越短
    cookiePreservedExpirationDate = cookie.expirationDate;
    cookieMaxAgeInput.value = '';
    const remainSeconds = Math.max(0, Math.floor(cookie.expirationDate - Date.now() / 1000));
    const expireText = new Date(cookie.expirationDate * 1000).toLocaleString();
    cookieMaxAgeInput.placeholder = '空=保持原过期';
    cookieMaxAgeInput.title = `原过期：${expireText}（剩余约 ${remainSeconds} 秒）。填写秒数则按相对时间重写`;
  }
}

/**
 * 清空保留的 cookie 过期时间，并恢复 Max-Age 默认提示
 */
function clearCookiePreservedExpiration() {
  cookiePreservedExpirationDate = null;
  cookieMaxAgeInput.placeholder = '秒，空=会话';
  cookieMaxAgeInput.title = '';
}

/**
 * 规范化用于 cookie 查询的 URL（去掉 hash，避免匹配失败）
 * @param {string} tabUrl
 * @returns {string}
 */
function normalizeCookieQueryUrl(tabUrl) {
  const parsedUrl = new URL(tabUrl);
  return `${parsedUrl.origin}${parsedUrl.pathname || '/'}`;
}

/**
 * 拆出当前路径及所有父级前缀（用于覆盖子路由 Path）
 * @param {string} pathname
 * @returns {string[]}
 */
function getPathPrefixes(pathname) {
  const rawPath = pathname || '/';
  const normalized =
    rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const prefixes = ['/'];
  const segments = normalized.split('/').filter(Boolean);
  let currentPath = '';
  segments.forEach((segment) => {
    currentPath += `/${segment}`;
    prefixes.push(currentPath);
  });
  return prefixes;
}

/**
 * cookie Path 是否覆盖当前页面路径
 * @param {string | undefined} cookiePath
 * @param {string} pagePathname
 * @returns {boolean}
 */
function isCookieMatchPath(cookiePath, pagePathname) {
  const path = cookiePath || '/';
  const pagePath = pagePathname || '/';
  if (path === '/') {
    return true;
  }
  if (pagePath === path) {
    return true;
  }
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return pagePath.startsWith(prefix);
}

/**
 * 获取标签页对应的 cookie storeId
 * @param {number} tabId
 * @returns {Promise<string | undefined>}
 */
async function getTabCookieStoreId(tabId) {
  const stores = await chrome.cookies.getAllCookieStores();
  const matchedStore = stores.find((store) => store.tabIds.includes(tabId));
  return matchedStore?.id;
}

/**
 * 生成可能相关的 domain 查询值
 * @param {string} hostname
 * @returns {string[]}
 */
function getCookieDomainCandidates(hostname) {
  const candidates = new Set([hostname]);
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const root = parts.slice(-2).join('.');
    candidates.add(root);
    candidates.add(`.${root}`);
  }
  if (parts.length >= 3) {
    const parent = parts.slice(-3).join('.');
    candidates.add(parent);
    candidates.add(`.${parent}`);
  }
  return Array.from(candidates);
}

/**
 * 确保具备读取目标站点 cookie 的主机权限
 * @param {string} tabUrl
 */
async function ensureCookieHostPermission(tabUrl) {
  const parsedUrl = new URL(tabUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('仅支持 http/https 页面读取 cookie');
  }

  const originPattern = `${parsedUrl.origin}/*`;
  const hasOrigin = await chrome.permissions.contains({ origins: [originPattern] });
  const hasWildcard = await chrome.permissions.contains({
    origins: ['http://*/*', 'https://*/*'],
  });

  if (hasOrigin || hasWildcard) {
    return;
  }

  const granted = await chrome.permissions.request({
    origins: ['http://*/*', 'https://*/*'],
  });
  if (!granted) {
    throw new Error(
      '未授予网站访问权限，无法读取 HttpOnly cookie。请打开 chrome://extensions → 本扩展详情 →「网站访问权限」设为「所有网站」，或点击弹窗允许权限后重试'
    );
  }
}

/**
 * 收集当前主机相关 cookie（含 HttpOnly、任意 Path/子路由）
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
async function collectTabCookies(tab) {
  if (!tab.url || !tab.id) {
    return [];
  }

  await ensureCookieHostPermission(tab.url);
  const storeId = await getTabCookieStoreId(tab.id);
  const parsedUrl = new URL(tab.url);
  const hostname = parsedUrl.hostname;
  const origin = parsedUrl.origin;
  const pathPrefixes = getPathPrefixes(parsedUrl.pathname || '/');
  const domainCandidates = getCookieDomainCandidates(hostname);

  /** @type {Map<string, chrome.cookies.Cookie>} */
  const merged = new Map();

  /**
   * @param {chrome.cookies.Cookie[]} list
   */
  const mergeCookies = (list) => {
    list.forEach((cookie) => {
      if (!isCookieMatchHostname(cookie, hostname)) {
        return;
      }
      const mapKey = `${cookie.name}\n${cookie.domain}\n${cookie.path}\n${cookie.storeId || ''}`;
      if (!merged.has(mapKey)) {
        merged.set(mapKey, cookie);
      }
    });
  };

  // 1. 拉取 store 内全部 cookie，再按主机过滤
  // 说明：仅用当前 url 查询时，Path 更具体的子路由 cookie（且 host-only）会被漏掉；
  // domain 查询又拿不到 host-only cookie，所以这里以全量 + 主机过滤为主。
  const allInStore = await chrome.cookies.getAll(storeId ? { storeId } : {});
  mergeCookies(allInStore);

  // 2. 按路径前缀逐级查询，覆盖子路由 Path
  for (const prefix of pathPrefixes) {
    const prefixUrl = `${origin}${prefix}`;
    const byPrefix = await chrome.cookies.getAll({
      url: prefixUrl,
      ...(storeId ? { storeId } : {}),
    });
    mergeCookies(byPrefix);
  }

  // 3. domain 再补一轮（带 Domain 属性的跨子域 cookie）
  for (const domain of domainCandidates) {
    const byDomain = await chrome.cookies.getAll({
      domain,
      ...(storeId ? { storeId } : {}),
    });
    mergeCookies(byDomain);
  }

  // 4. storeId 异常时兜底
  if (!merged.size) {
    mergeCookies(await chrome.cookies.getAll({}));
    for (const prefix of pathPrefixes) {
      mergeCookies(await chrome.cookies.getAll({ url: `${origin}${prefix}` }));
    }
  }

  return Array.from(merged.values());
}

/**
 * 判断 cookie 是否适用于当前主机
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} hostname
 * @returns {boolean}
 */
function isCookieMatchHostname(cookie, hostname) {
  const rawDomain = cookie.domain || '';
  const normalizedDomain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
  if (!normalizedDomain) {
    return true;
  }
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

/**
 * 在同名 cookie 中选出更适合当前路由的一条
 * @param {chrome.cookies.Cookie[]} cookies
 * @param {string} pagePathname
 * @returns {chrome.cookies.Cookie | null}
 */
function pickPreferredCookie(cookies, pagePathname) {
  if (!cookies.length) {
    return null;
  }

  const ranked = [...cookies].sort((left, right) => {
    const leftMatch = isCookieMatchPath(left.path, pagePathname) ? 1 : 0;
    const rightMatch = isCookieMatchPath(right.path, pagePathname) ? 1 : 0;
    if (rightMatch !== leftMatch) {
      return rightMatch - leftMatch;
    }
    const pathScore = (right.path || '/').length - (left.path || '/').length;
    if (pathScore !== 0) {
      return pathScore;
    }
    return Number(right.hostOnly) - Number(left.hostOnly);
  });

  return ranked[0];
}

/**
 * 通过 chrome.cookies 读取单个 cookie（含 HttpOnly）
 * @param {chrome.tabs.Tab} tab
 * @param {string} key
 */
async function readCookieViaApi(tab, key) {
  const routeInfo = buildRouteInfoFromTab(tab);
  const hostname = (() => {
    try {
      return new URL(tab.url || '').hostname;
    } catch {
      return '';
    }
  })();
  const pathname = (() => {
    try {
      return new URL(tab.url || '').pathname || '/';
    } catch {
      return '/';
    }
  })();

  const allCookies = await collectTabCookies(tab);
  const matchedCookies = allCookies.filter(
    (cookie) => cookie.name === key && isCookieMatchHostname(cookie, hostname)
  );
  const cookie = pickPreferredCookie(matchedCookies, pathname);

  if (!cookie) {
    clearCookiePreservedExpiration();
    return { ...routeInfo, value: null, cookie: null, httpOnly: false };
  }

  cookieDetailCache[buildCookieCacheKey(cookie)] = cookie;
  applyCookieDetailsToForm(cookie);
  return {
    ...routeInfo,
    value: cookie.value,
    cookie,
    httpOnly: Boolean(cookie.httpOnly),
  };
}

/**
 * 通过 chrome.cookies 列出当前页可见 cookie（含 HttpOnly；同名多 Path 全部保留）
 * @param {chrome.tabs.Tab} tab
 */
async function listCookiesViaApi(tab) {
  const routeInfo = buildRouteInfoFromTab(tab);
  const hostname = (() => {
    try {
      return new URL(tab.url || '').hostname;
    } catch {
      return '';
    }
  })();

  const cookies = (await collectTabCookies(tab)).filter((cookie) =>
    isCookieMatchHostname(cookie, hostname)
  );

  /** @type {Record<string, string>} */
  const entries = {};
  /** @type {Record<string, chrome.cookies.Cookie>} */
  const details = {};

  cookies.forEach((cookie) => {
    const cacheKey = buildCookieCacheKey(cookie);
    entries[cacheKey] = cookie.value;
    details[cacheKey] = cookie;
  });

  cookieDetailCache = details;
  const keys = Object.keys(details).sort((leftKey, rightKey) => {
    const left = details[leftKey];
    const right = details[rightKey];
    const nameCmp = left.name.localeCompare(right.name);
    if (nameCmp !== 0) {
      return nameCmp;
    }
    const pathCmp = (left.path || '/').localeCompare(right.path || '/');
    if (pathCmp !== 0) {
      return pathCmp;
    }
    return String(left.domain || '').localeCompare(String(right.domain || ''));
  });
  const httpOnlyCount = keys.filter((cacheKey) => details[cacheKey]?.httpOnly).length;
  return {
    ...routeInfo,
    keys,
    entries,
    cookieDetails: details,
    cookies: keys.map((cacheKey) => serializeCookieForExport(details[cacheKey])),
    httpOnlyCount,
    totalCount: keys.length,
  };
}

/**
 * 通过 chrome.cookies 写入 cookie（可设 HttpOnly）
 * @param {chrome.tabs.Tab} tab
 * @param {string} key
 * @param {string} value
 * @param {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string, httpOnly: boolean, expirationDate?: number | null }} options
 * @param {'replace-all-same-name' | 'upsert-identity'} [conflictMode]
 */
async function writeCookieViaApi(tab, key, value, options, conflictMode = 'replace-all-same-name') {
  const routeInfo = buildRouteInfoFromTab(tab);
  await ensureCookieHostPermission(tab.url || '');
  const storeId = tab.id ? await getTabCookieStoreId(tab.id) : undefined;

  let sameSite = mapSameSiteToApi(options.sameSite);
  let secure = Boolean(options.secure);
  const httpOnly = Boolean(options.httpOnly);

  if (sameSite === 'no_restriction') {
    secure = true;
    cookieSecureCheckbox.checked = true;
  }

  const nextPath = options.path || '/';
  const nextDomainNorm = (options.domain || '').replace(/^\./, '');

  // 写入前清理冲突项：
  // - replace-all-same-name：删掉同名全部（表单单条写入，避免改 Path 残留）
  // - upsert-identity：只删同 identity（导入多 Path 同名时互不影响）
  const existingCookies = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  for (const cookie of existingCookies) {
    const oldPath = cookie.path || '/';
    const oldDomainNorm = cookie.hostOnly ? '' : String(cookie.domain || '').replace(/^\./, '');
    const isSameIdentity = oldPath === nextPath && oldDomainNorm === nextDomainNorm;
    if (conflictMode === 'replace-all-same-name' || isSameIdentity) {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: key,
        storeId: cookie.storeId,
      });
    }
  }

  /** @type {chrome.cookies.SetDetails} */
  const details = {
    url: normalizeCookieQueryUrl(tab.url || ''),
    name: key,
    value,
    path: nextPath,
    secure,
    httpOnly,
  };

  if (options.domain) {
    details.domain = options.domain;
  }
  if (sameSite) {
    details.sameSite = sameSite;
  }
  if (options.maxAge !== null && options.maxAge !== undefined && Number.isFinite(options.maxAge)) {
    details.expirationDate = Date.now() / 1000 + options.maxAge;
  } else if (
    options.expirationDate !== null &&
    options.expirationDate !== undefined &&
    Number.isFinite(options.expirationDate)
  ) {
    // 沿用读取时的绝对过期时间
    details.expirationDate = options.expirationDate;
  }
  if (storeId) {
    details.storeId = storeId;
  }

  const result = await chrome.cookies.set(details);
  if (!result) {
    return { ...routeInfo, value: null, success: false, httpOnly };
  }

  cookieDetailCache[buildCookieCacheKey(result)] = result;
  applyCookieDetailsToForm(result);
  return {
    ...routeInfo,
    value: result.value,
    success: result.value === value,
    httpOnly: Boolean(result.httpOnly),
    cookie: result,
  };
}

/**
 * 通过 chrome.cookies 删除 cookie（含 HttpOnly）
 * @param {chrome.tabs.Tab} tab
 * @param {string} key
 * @param {{ path?: string, domain?: string }} [options]
 */
async function deleteCookieViaApi(tab, key, options = {}) {
  const routeInfo = buildRouteInfoFromTab(tab);
  await ensureCookieHostPermission(tab.url || '');

  const matchedCookies = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  const cached = cookieDetailCache[key];
  const targets = matchedCookies.length ? matchedCookies : cached ? [cached] : [];

  if (!targets.length) {
    const storeId = tab.id ? await getTabCookieStoreId(tab.id) : undefined;
    await chrome.cookies.remove({
      url: normalizeCookieQueryUrl(tab.url || ''),
      name: key,
      ...(storeId ? { storeId } : {}),
    });
  } else {
    for (const cookie of targets) {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: key,
        storeId: cookie.storeId,
      });
    }
  }

  const remainAfter = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  if (remainAfter.length) {
    for (const cookie of remainAfter) {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: key,
        storeId: cookie.storeId,
      });
    }
  }

  if (options.path || options.domain) {
    try {
      const parsed = new URL(tab.url || '');
      const domain = (options.domain || parsed.hostname).replace(/^\./, '');
      const path = options.path || '/';
      const storeId = tab.id ? await getTabCookieStoreId(tab.id) : undefined;
      for (const protocol of ['https:', 'http:']) {
        await chrome.cookies.remove({
          url: `${protocol}//${domain}${path}`,
          name: key,
          ...(storeId ? { storeId } : {}),
        });
      }
    } catch {
      // 忽略兜底失败
    }
  }

  const remainFinal = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  if (!remainFinal.length) {
    Object.keys(cookieDetailCache).forEach((cacheKey) => {
      if (cookieDetailCache[cacheKey]?.name === key) {
        delete cookieDetailCache[cacheKey];
      }
    });
  }
  return { ...routeInfo, success: remainFinal.length === 0 };
}

/**
 * 批量通过 chrome.cookies 写入（共用同一套表单选项，兼容旧导入）
 * @param {chrome.tabs.Tab} tab
 * @param {Record<string, string>} entries
 * @param {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string, httpOnly: boolean, expirationDate?: number | null }} options
 */
async function writeCookiesBatchViaApi(tab, entries, options) {
  const routeInfo = buildRouteInfoFromTab(tab);
  let successCount = 0;
  let failCount = 0;
  const entryList = Object.entries(entries || {});

  for (const [key, rawValue] of entryList) {
    const value = rawValue == null ? '' : String(rawValue);
    try {
      const result = await writeCookieViaApi(tab, key, value, options);
      if (result.success) {
        successCount += 1;
      } else {
        failCount += 1;
      }
    } catch {
      failCount += 1;
    }
  }

  return { ...routeInfo, successCount, failCount, total: entryList.length };
}

/**
 * 按每条 cookie 自身属性批量写入（用于带详情的导入）
 * @param {chrome.tabs.Tab} tab
 * @param {Array<ReturnType<typeof normalizeImportedCookieItem>>} cookieItems
 */
async function writeCookiesDetailedBatchViaApi(tab, cookieItems) {
  const routeInfo = buildRouteInfoFromTab(tab);
  let successCount = 0;
  let failCount = 0;
  const list = (cookieItems || []).filter(Boolean);

  for (const item of list) {
    try {
      const result = await writeCookieViaApi(
        tab,
        item.name,
        item.value,
        {
          path: item.path,
          domain: item.domain,
          secure: item.secure,
          httpOnly: item.httpOnly,
          sameSite: item.sameSite,
          maxAge: item.maxAge,
          expirationDate: item.expirationDate,
        },
        'upsert-identity'
      );
      if (result.success) {
        successCount += 1;
      } else {
        failCount += 1;
      }
    } catch {
      failCount += 1;
    }
  }

  return { ...routeInfo, successCount, failCount, total: list.length };
}

/**
 * 统一读取（cookie 走 API，其余走页面注入）
 * @param {chrome.tabs.Tab} tab
 * @param {string} storageType
 * @param {string} key
 */
async function readStorageValue(tab, storageType, key) {
  if (storageType === STORAGE_TYPES.cookie) {
    return readCookieViaApi(tab, key);
  }
  return executeInTab(tab.id, readPageStorage, [storageType, key]);
}

/**
 * 统一写入
 * @param {chrome.tabs.Tab} tab
 * @param {string} storageType
 * @param {string} key
 * @param {string} value
 * @param {ReturnType<typeof getCookieWriteOptions>} [cookieOptions]
 */
async function writeStorageValue(tab, storageType, key, value, cookieOptions) {
  // textarea 取值始终按字符串写入，避免异常类型
  const textValue = value == null ? '' : String(value);

  if (storageType === STORAGE_TYPES.cookie) {
    return writeCookieViaApi(tab, key, textValue, cookieOptions || getCookieWriteOptions());
  }
  return executeInTab(tab.id, writePageStorage, [storageType, key, textValue, cookieOptions ?? null]);
}

/**
 * 统一删除
 * @param {chrome.tabs.Tab} tab
 * @param {string} storageType
 * @param {string} key
 * @param {{ path?: string, domain?: string }} [cookieOptions]
 */
async function deleteStorageValue(tab, storageType, key, cookieOptions) {
  if (storageType === STORAGE_TYPES.cookie) {
    return deleteCookieViaApi(tab, key, cookieOptions);
  }
  return executeInTab(tab.id, deletePageStorage, [storageType, key, cookieOptions ?? null]);
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
 * - key：读取行下方（读取 / 历史 / 全部 Key / 导入导出）
 * - action：值区工具栏下方（写入 / 删除 / 格式化 / 压缩 / 粘贴 / 复制 / 清空）
 * @param {string} text
 * @param {'success' | 'error' | 'empty' | 'pending' | ''} type
 * @param {'key' | 'action'} [zone]
 */
function setStatus(text, type = '', zone = STATUS_ZONE.key) {
  const targetEl = zone === STATUS_ZONE.action ? actionStatusTextEl : statusTextEl;
  const otherEl = zone === STATUS_ZONE.action ? statusTextEl : actionStatusTextEl;
  const nextType = type || (text ? 'pending' : '');

  // 同一时刻只突出一个反馈区，避免上下同时闪提示
  if (text && otherEl) {
    otherEl.textContent = '';
    otherEl.className =
      zone === STATUS_ZONE.action ? 'status status-key' : 'status status-action';
  }

  targetEl.textContent = text;
  targetEl.className = `status${zone === STATUS_ZONE.action ? ' status-action' : ' status-key'}${
    nextType ? ` is-${nextType}` : ''
  }`;

  if (!text) {
    return;
  }

  if (nextType === 'error' || nextType === 'empty' || nextType === 'success') {
    targetEl.classList.remove('is-flash');
    // 触发重绘以重启动画
    void targetEl.offsetWidth;
    targetEl.classList.add('is-flash');
    targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/**
 * 值区操作反馈（写入 / 删除 / 格式化等）
 * @param {string} text
 * @param {'success' | 'error' | 'empty' | 'pending' | ''} type
 */
function setActionStatus(text, type = '') {
  setStatus(text, type, STATUS_ZONE.action);
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
 * @returns {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string, httpOnly: boolean, expirationDate: number | null }}
 */
function getCookieWriteOptions() {
  const path = cookiePathInput.value.trim() || '/';
  const maxAgeRaw = cookieMaxAgeInput.value.trim();
  const maxAgeNumber = maxAgeRaw === '' ? null : Number(maxAgeRaw);
  const maxAge = maxAgeNumber !== null && Number.isFinite(maxAgeNumber) && maxAgeNumber >= 0 ? maxAgeNumber : null;
  const domain = cookieDomainInput.value.trim();
  let sameSite = cookieSameSiteSelect.value;
  let secure = cookieSecureCheckbox.checked;
  const httpOnly = cookieHttpOnlyCheckbox.checked;

  if (sameSite === 'None') {
    secure = true;
    cookieSecureCheckbox.checked = true;
  }

  // Max-Age 有值：按相对秒数；否则若有保留的绝对过期则沿用；再否则为会话 cookie
  const expirationDate =
    maxAge === null && cookiePreservedExpirationDate !== null ? cookiePreservedExpirationDate : null;

  return { path, maxAge, domain, secure, sameSite, httpOnly, expirationDate };
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
 * 同步历史面板显隐与按钮态
 */
function syncHistoryPanelVisibility() {
  historyPanelEl.hidden = !isHistoryPanelOpen;
  toggleHistoryBtn.classList.toggle('is-active', isHistoryPanelOpen);
  toggleHistoryBtn.setAttribute('aria-expanded', String(isHistoryPanelOpen));
}

/**
 * 切换历史面板
 */
function toggleHistoryPanel() {
  isHistoryPanelOpen = !isHistoryPanelOpen;
  syncHistoryPanelVisibility();
  renderKeyHistory(historyKeyCache);
}

/**
 * 渲染最近 key 历史
 * @param {string[]} historyList
 */
function renderKeyHistory(historyList) {
  const list = normalizeHistoryList(historyList);
  historyKeyCache = list;

  syncHistoryPanelVisibility();

  if (!list.length) {
    historyRowEl.innerHTML = '';
    historyRowEl.classList.remove('is-scrollable');
    historyRowEl.hidden = true;
    historyEmptyTipEl.hidden = false;
    clearHistoryBtn.disabled = true;
    return;
  }

  historyEmptyTipEl.hidden = true;
  historyRowEl.hidden = false;
  clearHistoryBtn.disabled = false;
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
    if (historyPanelEl.hidden) {
      return;
    }
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

    let pageData;
    if (currentStorageType === STORAGE_TYPES.cookie) {
      pageData = await listCookiesViaApi(tab);
    } else {
      pageData = await executeInTab(tab.id, listPageStorageKeys, [currentStorageType]);
      cookieDetailCache = {};
    }

    pageKeyCache = Array.isArray(pageData.keys) ? pageData.keys : [];
    pageEntriesCache =
      pageData.entries && typeof pageData.entries === 'object' ? pageData.entries : {};
    pageKeysCacheReady = true;
    pageKeysFetchedAt = Date.now();
    if (renderList || !keysPanelEl.hidden) {
      renderKeysList(keysFilterInput.value.trim());
    }
    return pageData;
  } catch (error) {
    pageKeyCache = [];
    pageEntriesCache = {};
    cookieDetailCache = {};
    pageKeysCacheReady = false;
    pageKeysFetchedAt = 0;
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
  const filteredKeys = pageKeyCache.filter((key) => {
    if (!keyword) {
      return true;
    }
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const detail = cookieDetailCache[key];
      const name = detail?.name || key;
      const path = detail?.path || '/';
      const domain = detail?.domain || '';
      return (
        name.toLowerCase().includes(keyword) ||
        path.toLowerCase().includes(keyword) ||
        domain.toLowerCase().includes(keyword)
      );
    }
    return key.toLowerCase().includes(keyword);
  });

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
      const detail = cookieDetailCache[key];
      const displayName =
        currentStorageType === STORAGE_TYPES.cookie && detail ? detail.name : key;
      const safeLabel = escapeHtml(displayName);
      const badges = [];
      if (currentStorageType === STORAGE_TYPES.cookie && detail) {
        // 同名多 Path 时 Path 始终展示，便于区分
        badges.push(
          `<span class="keys-badge is-path" title="Path">${escapeHtml(detail.path || '/')}</span>`
        );
        if (detail.domain && !detail.hostOnly) {
          badges.push(
            `<span class="keys-badge is-domain" title="Domain">${escapeHtml(detail.domain)}</span>`
          );
        }
        if (detail.httpOnly) {
          badges.push('<span class="keys-badge is-httponly">HttpOnly</span>');
        }
        if (detail.secure) {
          badges.push('<span class="keys-badge is-secure">Secure</span>');
        }
      } else if (detail?.path && detail.path !== '/') {
        badges.push(`<span class="keys-badge is-path" title="Path">${escapeHtml(detail.path)}</span>`);
        if (detail?.httpOnly) {
          badges.push('<span class="keys-badge is-httponly">HttpOnly</span>');
        }
        if (detail?.secure) {
          badges.push('<span class="keys-badge is-secure">Secure</span>');
        }
      }
      const badgeHtml = badges.length
        ? `<span class="keys-item-badges">${badges.join('')}</span>`
        : '';
      const titleText =
        currentStorageType === STORAGE_TYPES.cookie && detail
          ? `${detail.name} | path=${detail.path || '/'}${detail.domain ? ` | domain=${detail.domain}` : ''}`
          : displayName;
      return `<button class="keys-item" type="button" data-key="${encodedKey}" title="${escapeHtml(titleText)}">
          <span class="keys-item-name">${safeLabel}</span>${badgeHtml}
        </button>`;
    })
    .join('');
}

/**
 * 同步全部 Key 面板按钮态
 */
function syncKeysPanelButton() {
  const isOpen = !keysPanelEl.hidden;
  browseKeysBtn.classList.toggle('is-active', isOpen);
  browseKeysBtn.setAttribute('aria-expanded', String(isOpen));
}

/**
 * 切换全部 Key 面板
 */
async function toggleKeysPanel() {
  if (!keysPanelEl.hidden) {
    keysPanelEl.hidden = true;
    syncKeysPanelButton();
    return;
  }

  keysPanelEl.hidden = false;
  syncKeysPanelButton();
  keysFilterInput.value = '';
  setStatus('正在加载全部 Key...', '');
  try {
    await refreshPageKeys(true);
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const httpOnlyCount = Object.values(cookieDetailCache).filter((item) => item.httpOnly).length;
      setStatus(
        `共 ${pageKeyCache.length} 个 cookie（HttpOnly ${httpOnlyCount}）`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    } else {
      setStatus(`共 ${pageKeyCache.length} 个 key`, pageKeyCache.length ? 'success' : 'empty');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载 Key 失败', 'error');
  }
}

/**
 * 取历史备选（最近使用倒序，最多 N 条）
 * @param {string} keyword
 * @returns {string[]}
 */
function getHistorySuggestKeys(keyword) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  // historyKeyCache 本身是最近在前
  const orderedHistory = historyKeyCache.filter((key) => {
    if (!normalizedKeyword) {
      return true;
    }
    return key.toLowerCase().includes(normalizedKeyword);
  });
  return orderedHistory.slice(0, HISTORY_SUGGEST_LIMIT);
}

/**
 * 仅用历史记录构建备选项（先展示，再异步补全页面 Key）
 * @param {string} query
 * @returns {Array<{ key: string, source: string, label?: string, cacheKey?: string }>}
 */
function buildHistorySuggestItems(query) {
  return getHistorySuggestKeys(query).map((key) => ({
    key,
    source: '历史记录',
  }));
}

/**
 * 合并联想候选：先历史倒序 3 条，再追加全部页面 Key（去重）
 * @param {string} query
 * @returns {Array<{ key: string, source: string, label?: string, cacheKey?: string }>}
 */
function buildSuggestItems(query) {
  const keyword = query.trim().toLowerCase();
  /** @type {Array<{ key: string, source: string, label?: string, cacheKey?: string }>} */
  const items = [];
  const seenKeys = new Set();

  getHistorySuggestKeys(query).forEach((key) => {
    items.push({ key, source: '历史记录' });
    seenKeys.add(`name:${key}`);
  });

  pageKeyCache.forEach((cacheKey) => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const detail = cookieDetailCache[cacheKey];
      if (!detail) {
        return;
      }
      const path = detail.path || '/';
      const label = `${detail.name} (${path})`;
      const dedupeId = `cookie:${cacheKey}`;
      if (seenKeys.has(dedupeId)) {
        return;
      }
      if (
        keyword &&
        !detail.name.toLowerCase().includes(keyword) &&
        !path.toLowerCase().includes(keyword)
      ) {
        return;
      }
      items.push({
        key: detail.name,
        label,
        cacheKey,
        source: '页面',
      });
      seenKeys.add(dedupeId);
      return;
    }

    if (seenKeys.has(`name:${cacheKey}`)) {
      return;
    }
    if (keyword && !cacheKey.toLowerCase().includes(keyword)) {
      return;
    }
    items.push({ key: cacheKey, source: '页面' });
    seenKeys.add(`name:${cacheKey}`);
  });

  return items;
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
 * 当前输入框是否仍持有焦点
 * @returns {boolean}
 */
function isStorageKeyInputFocused() {
  return document.activeElement === storageKeyInput;
}

/**
 * 渲染联想列表
 * @param {{ loading?: boolean }} [options]
 */
function renderKeySuggest(options = {}) {
  const { loading = false } = options;

  if (!suggestItems.length) {
    if (loading && isStorageKeyInputFocused()) {
      keySuggestListEl.hidden = false;
      keySuggestListEl.innerHTML =
        '<li class="key-suggest-item is-muted" role="option">加载备选中...</li>';
      return;
    }
    hideKeySuggest();
    return;
  }

  keySuggestListEl.hidden = false;
  keySuggestListEl.innerHTML = suggestItems
    .map((item, index) => {
      const activeClass = index === suggestActiveIndex ? ' is-active' : '';
      const label = item.label || item.key;
      return `<li class="key-suggest-item${activeClass}" role="option" data-index="${index}">
        <span>${escapeHtml(label)}</span>
        <span class="key-suggest-source">${escapeHtml(item.source)}</span>
      </li>`;
    })
    .join('');
}

/**
 * 页面 Key 缓存是否仍可用于联想过滤
 * @returns {boolean}
 */
function isPageKeysCacheFresh() {
  return pageKeysCacheReady && Date.now() - pageKeysFetchedAt < PAGE_KEYS_CACHE_TTL_MS;
}

/**
 * 使页面 Key 缓存失效（切换类型等）
 */
function invalidatePageKeysCache() {
  pageKeysCacheReady = false;
  pageKeysFetchedAt = 0;
}

/**
 * 刷新并展示联想：先历史 3 条；有缓存则本地过滤，否则防抖后再拉页面 Key
 * @param {boolean} [forceShow]
 */
async function updateKeySuggest(forceShow = false) {
  const requestId = ++suggestRequestId;
  const query = storageKeyInput.value;

  // 未聚焦且非强制时不展示（避免无关调用把列表关掉又打开）
  if (!forceShow && !isStorageKeyInputFocused()) {
    return;
  }

  // 缓存仍新鲜：只做本地过滤，避免 Cookie 场景每次按键全量拉取
  if (isPageKeysCacheFresh()) {
    suggestItems = buildSuggestItems(query);
    suggestActiveIndex = suggestItems.length ? 0 : -1;
    renderKeySuggest({ loading: false });
    return;
  }

  // 无缓存：先立刻展示历史；异步防抖后再拉页面 Key
  suggestItems = buildHistorySuggestItems(query);
  suggestActiveIndex = suggestItems.length ? 0 : -1;
  renderKeySuggest({ loading: !suggestItems.length });

  if (suggestDebounceTimer) {
    clearTimeout(suggestDebounceTimer);
  }

  suggestDebounceTimer = setTimeout(async () => {
    suggestDebounceTimer = null;
    try {
      await refreshPageKeys(false);
    } catch {
      // 页面 Key 加载失败时保留历史备选
    }

    // 过期请求或已失焦：不再回写，防止把正在展示的列表清掉
    if (requestId !== suggestRequestId) {
      return;
    }
    if (!isStorageKeyInputFocused()) {
      return;
    }

    suggestItems = buildSuggestItems(storageKeyInput.value);
    suggestActiveIndex = suggestItems.length ? 0 : -1;
    renderKeySuggest({ loading: false });
  }, forceShow ? 0 : SUGGEST_DEBOUNCE_MS);
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
  if (item.cacheKey && cookieDetailCache[item.cacheKey]) {
    await handleSelectCookieListKey(item.cacheKey);
    return;
  }
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
  cookieDetailCache = {};
  invalidatePageKeysCache();
  clearCookiePreservedExpiration();
  cookieMaxAgeInput.value = '';

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

  if (storageKeyInput.value.trim()) {
    await handleRead();
  } else {
    const lastValueField = getLastValueField(storageType);
    const stored = await chrome.storage.local.get(lastValueField);
    valueInput.value = typeof stored[lastValueField] === 'string' ? stored[lastValueField] : '';
    autoResizeValueInput();
    updateValueMeta();
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
 * 从全部 Key 列表点选某条 cookie（按 Path/Domain 精确回填并读取）
 * @param {string} cacheKey
 */
async function handleSelectCookieListKey(cacheKey) {
  if (isBusy) {
    return;
  }

  const cookie = cookieDetailCache[cacheKey];
  if (!cookie) {
    setStatus('未找到该 cookie 详情，请刷新后重试', 'error');
    return;
  }

  hideKeySuggest();
  storageKeyInput.value = cookie.name;
  syncClearKeyButton();
  applyCookieDetailsToForm(cookie);

  setBusy(true);
  setStatus('读取中...');
  try {
    valueInput.value = cookie.value ?? '';
    autoResizeValueInput();
    updateValueMeta();
    clearNestedStringRestoreMap();
    await pushKeyHistory(cookie.name);
    await saveLastValue(cookie.value ?? '');
    const byteLength = new TextEncoder().encode(cookie.value ?? '').length;
    const httpOnlyTip = cookie.httpOnly ? ' · HttpOnly' : '';
    const pathTip = ` · path=${cookie.path || '/'}`;
    setStatus(
      `读取成功（cookie${httpOnlyTip}${pathTip}），${(cookie.value || '').length} 字符 · ${byteLength} 字节`,
      'success'
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '读取失败', 'error');
  } finally {
    setBusy(false);
  }
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

    const pageData = await readStorageValue(tab, currentStorageType, key);
    await pushKeyHistory(key);

    if (pageData.value === null) {
      valueInput.value = '';
      autoResizeValueInput();
      updateValueMeta();
      clearNestedStringRestoreMap();
      setStatus(`key "${key}" 不存在`, 'empty');
    } else {
      valueInput.value = pageData.value;
      autoResizeValueInput();
      updateValueMeta();
      clearNestedStringRestoreMap();
      await saveLastValue(pageData.value);
      const byteLength = new TextEncoder().encode(pageData.value).length;
      const httpOnlyTip = pageData.httpOnly ? ' · HttpOnly' : '';
      setStatus(
        `读取成功（${getStorageTypeLabel(currentStorageType)}${httpOnlyTip}），${pageData.value.length} 字符 · ${byteLength} 字节`,
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
 * 写入前处理值：还原格式化展开态，并压缩合法 JSON
 * 不依赖 formatExpandActive 单一开关，避免状态丢失后把展开态写进去
 * @param {string} rawText
 * @returns {{ text: string, restoredCount: number, usedFallback: boolean, minified: boolean }}
 */
function prepareValueForWrite(rawText) {
  let text = rawText;
  let restoredCount = 0;
  let usedFallback = false;
  let minified = false;
  const restoreMap = getActiveFormatRestoreMap();

  // 1) 优先按还原表把嵌套字符串还原回去
  if (restoreMap && restoreMap.size > 0) {
    try {
      const parsed = JSON.parse(text.trim());
      const previousMap = nestedStringRestoreMap;
      nestedStringRestoreMap = restoreMap;
      try {
        const counter = { restoredCount: 0 };
        const restored = deepRestoreJsonValue(parsed, counter);
        if (counter.restoredCount > 0) {
          text = JSON.stringify(restored);
          restoredCount = counter.restoredCount;
          minified = true;
        }
      } finally {
        nestedStringRestoreMap = previousMap;
      }
    } catch {
      // 继续走原文回退
    }
  }

  // 2) 还原表无效但还留着格式化前原文 → 直接回退原文（格式化仅作阅读）
  if (restoredCount === 0 && preFormatRootText) {
    text = preFormatRootText;
    usedFallback = true;
  }

  // 3) 合法 JSON 一律压缩（去掉缩进）；已 minify 的再 parse 一次也无妨
  try {
    text = JSON.stringify(JSON.parse(text.trim()));
    minified = true;
  } catch {
    // 非 JSON 保持原样
  }

  return { text, restoredCount, usedFallback, minified };
}

/**
 * 获取当前可用的格式化还原表
 * @returns {Map<string, string> | null}
 */
function getActiveFormatRestoreMap() {
  if (nestedStringRestoreMap.size > 0) {
    return nestedStringRestoreMap;
  }
  if (formatRestoreMapBackup && formatRestoreMapBackup.size > 0) {
    return formatRestoreMapBackup;
  }
  return null;
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

  if (!valueInput.value) {
    setActionStatus('请先粘贴或输入要写入的值', 'error');
    valueInput.focus();
    return;
  }

  // 写入前始终做还原 + 压缩，避免展开态/缩进态直接入库
  const prepared = prepareValueForWrite(valueInput.value);
  let value = prepared.text;
  valueInput.value = value;
  autoResizeValueInput();
  updateValueMeta();

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    const existingData = await readStorageValue(tab, currentStorageType, key);
    if (existingData.value !== null && existingData.value !== value) {
      const confirmed = await showConfirmDialog({
        title: `确认覆盖写入「${key}」？`,
        body: `旧值（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}\n\n新值（${value.length} 字符）：\n${truncateText(value)}`,
        okText: '确认覆盖',
        danger: true,
      });
      if (!confirmed) {
        setActionStatus('已取消写入', 'empty');
        return;
      }
    } else if (existingData.value === null) {
      const confirmed = await showConfirmDialog({
        title: `确认新建写入「${key}」？`,
        body: `将写入新值（${value.length} 字符）：\n${truncateText(value)}`,
        okText: '确认写入',
      });
      if (!confirmed) {
        setActionStatus('已取消写入', 'empty');
        return;
      }
    }

    setBusy(true);
    if (prepared.usedFallback) {
      setActionStatus('已回退格式化前原文并压缩，写入中...');
    } else if (prepared.restoredCount > 0) {
      setActionStatus(`已还原 ${prepared.restoredCount} 处并压缩，写入中...`);
    } else if (prepared.minified) {
      setActionStatus('已压缩，写入中...');
    } else {
      setActionStatus('写入中...');
    }

    const cookieOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : undefined;
    const pageData = await writeStorageValue(
      tab,
      currentStorageType,
      key,
      value,
      cookieOptions
    );
    // 写入成功后再清格式化状态，避免确认取消后丢还原信息
    clearFormatRestoreState();
    valueInput.value = pageData.value ?? value;
    autoResizeValueInput();
    updateValueMeta();
    await pushKeyHistory(key);
    await saveLastValue(value);

    if (!pageData.success) {
      const failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '写入后回读不一致（可能被浏览器拒绝：Secure/SameSite/Domain/大小限制等）'
          : '写入后回读不一致，请确认页面是否允许写入';
      setActionStatus(failTip, 'error');
      return;
    }

    let cookieTip = '';
    if (currentStorageType === STORAGE_TYPES.cookie && cookieOptions) {
      const parts = [`path=${cookieOptions.path}`];
      if (cookieOptions.maxAge !== null) {
        parts.push(`Max-Age=${cookieOptions.maxAge}`);
      } else if (cookieOptions.expirationDate) {
        parts.push(`保持过期至 ${new Date(cookieOptions.expirationDate * 1000).toLocaleString()}`);
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
      if (cookieOptions.httpOnly) {
        parts.push('HttpOnly');
      }
      cookieTip = `（${parts.join('，')}）`;
    }

    let prepareTip = '';
    if (prepared.usedFallback) {
      prepareTip = '，已回退格式化前原文';
    } else if (prepared.restoredCount > 0) {
      prepareTip = `，已还原 ${prepared.restoredCount} 处嵌套字符串`;
    } else if (prepared.minified) {
      prepareTip = '，已压缩';
    }
    setActionStatus(
      `写入成功：${getStorageTypeLabel(currentStorageType)} / ${key}（长度 ${value.length}）${cookieTip}${prepareTip}`,
      'success'
    );

    if (!keysPanelEl.hidden) {
      refreshPageKeys(true).catch(() => {});
    } else {
      refreshPageKeys(false).catch(() => {});
    }
  } catch (error) {
    setActionStatus(error instanceof Error ? error.message : '写入失败', 'error');
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
    const existingData = await readStorageValue(tab, currentStorageType, key);

    let body =
      existingData.value === null
        ? `当前读不到「${key}」的值（可能不存在）。仍尝试删除？`
        : `将删除「${key}」当前值（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}`;

    if (existingData.httpOnly) {
      body += '\n\n该 cookie 为 HttpOnly，将通过 chrome.cookies API 删除。';
    }

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
      setActionStatus('已取消删除', 'empty');
      return;
    }

    setBusy(true);
    setActionStatus('删除中...');

    const writeOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : null;
    const cookieOptions = writeOptions
      ? { path: writeOptions.path, domain: writeOptions.domain }
      : undefined;
    const pageData = await deleteStorageValue(tab, currentStorageType, key, cookieOptions);

    if (!pageData.success) {
      const failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '删除失败：cookie 仍存在。可尝试修改 Path/Domain 后再删'
          : '删除失败：key 仍存在';
      setActionStatus(failTip, 'error');
      return;
    }

    valueInput.value = '';
    autoResizeValueInput();
    updateValueMeta();
    if (currentStorageType === STORAGE_TYPES.cookie) {
      clearCookiePreservedExpiration();
      cookieMaxAgeInput.value = '';
    }
    await pushKeyHistory(key);
    await saveLastValue('');
    setActionStatus(`已删除：${typeLabel} / ${key}`, 'success');

    if (!keysPanelEl.hidden) {
      refreshPageKeys(true).catch(() => {});
    } else {
      refreshPageKeys(false).catch(() => {});
    }
  } catch (error) {
    setActionStatus(error instanceof Error ? error.message : '删除失败', 'error');
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
    /** @type {Record<string, any>} */
    const payload = {
      type: currentStorageType,
      version: 2,
      exportedAt: new Date().toISOString(),
      origin: pageData.origin || '',
      data: pageData.entries || {},
    };

    if (currentStorageType === STORAGE_TYPES.cookie) {
      const cookieList = Array.isArray(pageData.cookies)
        ? pageData.cookies
        : Object.values(cookieDetailCache).map((cookie) => serializeCookieForExport(cookie));
      payload.cookies = cookieList;
      // 兼容旧导入：data 仍提供 name -> value（同名多 Path 时保留列表中第一条）
      /** @type {Record<string, string>} */
      const compatData = {};
      cookieList.forEach((item) => {
        if (item?.name && compatData[item.name] === undefined) {
          compatData[item.name] = item.value == null ? '' : String(item.value);
        }
      });
      payload.data = compatData;
      setStatus(`已导出 ${cookieList.length} 个 cookie（含 Path/HttpOnly 等详情）`, 'success');
    } else {
      setStatus(`已导出 ${Object.keys(payload.data).length} 个 key`, 'success');
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `${currentStorageType}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 解析导入 JSON
 * @param {string} text
 * @returns {{ mode: 'cookieDetails', cookies: Array<NonNullable<ReturnType<typeof normalizeImportedCookieItem>>>, type?: string } | { mode: 'entries', entries: Record<string, string>, type?: string }}
 */
function parseImportPayload(text) {
  const parsed = JSON.parse(text);
  const payloadType = parsed && typeof parsed === 'object' ? parsed.type : undefined;

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cookies) && parsed.cookies.length) {
    const cookies = parsed.cookies
      .map((item) => normalizeImportedCookieItem(item))
      .filter(Boolean);
    if (!cookies.length) {
      throw new Error('导入 cookies 详情为空或格式无效');
    }
    return { mode: 'cookieDetails', cookies, type: payloadType };
  }

  let rawEntries = parsed;
  if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
    rawEntries = parsed.data;
  }

  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    throw new Error(
      '导入格式无效，需要 { key: value }、{ data: { key: value } } 或 { cookies: [...] }'
    );
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

  return { mode: 'entries', entries, type: payloadType };
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
    const payload = parseImportPayload(text);

    if (payload.type && payload.type !== currentStorageType) {
      const confirmedType = await showConfirmDialog({
        title: '导入类型不一致',
        body: `文件类型是「${payload.type}」，当前是「${currentStorageType}」。仍要导入到当前类型吗？`,
        okText: '继续导入',
        danger: true,
      });
      if (!confirmedType) {
        setStatus('已取消导入', 'empty');
        return;
      }
    }

    let preview = '';
    let totalCount = 0;
    if (payload.mode === 'cookieDetails') {
      totalCount = payload.cookies.length;
      preview = payload.cookies
        .slice(0, 8)
        .map((item) => `- ${item.name} (path=${item.path}${item.httpOnly ? ', HttpOnly' : ''})`)
        .join('\n');
    } else {
      totalCount = Object.keys(payload.entries).length;
      preview = Object.keys(payload.entries)
        .slice(0, 8)
        .map((key) => `- ${key}`)
        .join('\n');
    }
    const moreTip = totalCount > 8 ? `\n…共 ${totalCount} 条` : '';

    const confirmed = await showConfirmDialog({
      title: `确认导入到 ${getStorageTypeLabel(currentStorageType)}？`,
      body: `将写入 / 覆盖以下条目：\n${preview}${moreTip}`,
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

    let result;
    if (currentStorageType === STORAGE_TYPES.cookie && payload.mode === 'cookieDetails') {
      result = await writeCookiesDetailedBatchViaApi(tab, payload.cookies);
    } else if (currentStorageType === STORAGE_TYPES.cookie) {
      const cookieOptions = getCookieWriteOptions();
      result = await writeCookiesBatchViaApi(tab, payload.entries, cookieOptions);
    } else if (payload.mode === 'entries') {
      result = await executeInTab(tab.id, writePageStorageBatch, [
        currentStorageType,
        payload.entries,
        null,
      ]);
    } else {
      throw new Error('当前类型不支持 cookies 详情导入，请切换到 cookie');
    }

    await refreshPageKeys(true);

    if (result.failCount > 0) {
      setStatus(`导入完成：成功 ${result.successCount}，失败 ${result.failCount}`, 'error');
    } else {
      setStatus(`导入成功：${result.successCount} 条`, 'success');
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
    setActionStatus('没有可复制的内容', 'empty');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    await saveLastValue(text);
    setActionStatus('已复制到剪贴板', 'success');
  } catch {
    setActionStatus('复制失败，请手动选中复制', 'error');
  }
}

/**
 * 从剪贴板粘贴到文本框
 */
async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setActionStatus('剪贴板为空', 'empty');
      return;
    }
    valueInput.value = text;
    autoResizeValueInput();
    updateValueMeta();
    clearNestedStringRestoreMap();
    setActionStatus(`已粘贴，长度 ${text.length}，可点击右上角「写入」`, 'success');
    valueInput.focus();
  } catch {
    setActionStatus('粘贴失败，请手动 Ctrl/Cmd + V 粘贴到输入框', 'error');
    valueInput.focus();
  }
}

/**
 * 将对象字面量中的函数表达式替换为 JSON 字符串，便于安全 JSON.parse
 * （扩展 CSP 禁止 new Function/eval，不能执行代码解析）
 * @param {string} text
 * @returns {string}
 */
function replaceFunctionsWithJsonStrings(text) {
  let result = '';
  let index = 0;

  while (index < text.length) {
    const colonIndex = text.indexOf(':', index);
    if (colonIndex < 0) {
      result += text.slice(index);
      break;
    }

    result += text.slice(index, colonIndex + 1);
    let cursor = colonIndex + 1;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }

    const remain = text.slice(cursor);
    let funcStart = -1;
    let bodyStart = -1;

    // key: function ... { / key: async function ... {
    const classicMatch = remain.match(/^(async\s+)?function\b/);
    // key: (...) => { 或 key: async (...) => {
    const arrowMatch = remain.match(/^(async\s*)?\([^)]*\)\s*=>\s*\{/);
    // key: name => { / key: async name => {
    const arrowIdentMatch = remain.match(/^(async\s+)?[A-Za-z_$][\w$]*\s*=>\s*\{/);

    if (classicMatch) {
      funcStart = cursor;
      const braceIndex = text.indexOf('{', cursor);
      if (braceIndex >= 0) {
        bodyStart = braceIndex;
      }
    } else if (arrowMatch) {
      funcStart = cursor;
      bodyStart = cursor + arrowMatch[0].length - 1;
    } else if (arrowIdentMatch) {
      funcStart = cursor;
      bodyStart = cursor + arrowIdentMatch[0].length - 1;
    }

    if (funcStart >= 0 && bodyStart >= 0 && text[bodyStart] === '{') {
      const bodyText = sliceBalancedFragment(text, bodyStart);
      if (bodyText) {
        const funcEnd = bodyStart + bodyText.length;
        const funcSource = text.slice(funcStart, funcEnd);
        result += JSON.stringify(funcSource);
        index = funcEnd;
        continue;
      }
    }

    // 未识别为函数：原样输出当前空白，继续从空白后扫描
    result += text.slice(colonIndex + 1, cursor);
    index = cursor;
  }

  return result;
}

/**
 * 宽松解析对象/数组文本（兼容尾逗号；不含 eval，遵守扩展 CSP）
 * @param {string} text
 * @returns {any}
 */
function parseStructuredData(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // 去掉尾逗号后再试
  try {
    const withoutTrailingComma = trimmed.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(withoutTrailingComma);
  } catch {
    // continue
  }

  // 将函数体替换为字符串后再解析（避免 new Function 触发 CSP 报错）
  try {
    const sanitized = replaceFunctionsWithJsonStrings(trimmed).replace(/,\s*([\]}])/g, '$1');
    const result = JSON.parse(sanitized);
    if (result !== null && typeof result === 'object') {
      return result;
    }
  } catch {
    // continue
  }

  return null;
}

/**
 * 若字符串仍含 JSON 转义形态（\" \\n），先解码一层
 * @param {string} text
 * @returns {string}
 */
function decodeEscapedTextLayer(text) {
  if (!text.includes('\\n') && !text.includes('\\"') && !text.includes('\\t')) {
    return text;
  }

  try {
    // text 本身已是 JSON 字符串的「内容转义形态」
    return JSON.parse(`"${text}"`);
  } catch {
    return text;
  }
}

/**
 * 从 start 起截取平衡的 {} 或 [] 片段
 * @param {string} text
 * @param {number} start
 * @returns {string | null}
 */
function sliceBalancedFragment(text, start) {
  const openChar = text[start];
  if (openChar !== '{' && openChar !== '[') {
    return null;
  }
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

/**
 * 提取文本中可解析的嵌入对象/数组（支持 jsCode: 注释 + var config = {...}）
 * @param {string} text
 * @returns {{ prefix: string, jsonText: string, suffix: string, parsed: any } | null}
 */
function extractBalancedJsonFragment(text) {
  const sourceText = decodeEscapedTextLayer(text);
  const startIndexes = [];

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{' || char === '[') {
      startIndexes.push(index);
    }
  }

  for (const start of startIndexes) {
    const jsonText = sliceBalancedFragment(sourceText, start);
    if (!jsonText) {
      continue;
    }
    const parsed = parseStructuredData(jsonText);
    if (parsed === null || typeof parsed !== 'object') {
      continue;
    }
    return {
      prefix: sourceText.slice(0, start),
      jsonText,
      suffix: sourceText.slice(start + jsonText.length),
      parsed,
    };
  }

  // 兼容 var config = {...}; / let/const config = {...}
  const assignMatch = sourceText.match(
    /(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/
  );
  if (assignMatch && assignMatch.index != null) {
    const jsonText = assignMatch[1];
    const parsed = parseStructuredData(jsonText);
    if (parsed !== null && typeof parsed === 'object') {
      const start = assignMatch.index + assignMatch[0].lastIndexOf(jsonText);
      return {
        prefix: sourceText.slice(0, start),
        jsonText,
        suffix: sourceText.slice(start + jsonText.length),
        parsed,
      };
    }
  }

  return null;
}

/**
 * 递归格式化时记录：路径 -> 展开前的原始字符串
 * （状态变量已在文件前部声明：nestedStringRestoreMap / formatExpandActive / preFormatRootText / formatRestoreMapBackup）
 */

/**
 * 清空格式化展开态与还原信息
 */
function clearFormatRestoreState() {
  nestedStringRestoreMap.clear();
  formatExpandActive = false;
  preFormatRootText = '';
  formatRestoreMapBackup = null;
}

/**
 * 清空嵌套字符串还原表（兼容旧调用）
 */
function clearNestedStringRestoreMap() {
  clearFormatRestoreState();
}

/**
 * 拼接 JSON 路径
 * @param {string} basePath
 * @param {string | number} key
 * @returns {string}
 */
function joinJsonPath(basePath, key) {
  if (!basePath) {
    return String(key);
  }
  return `${basePath}.${key}`;
}

/**
 * 展示用序列化：函数转成源码字符串，避免被 JSON.stringify 直接丢掉
 * @param {any} value
 * @param {number} [space]
 * @returns {string}
 */
function stringifyForDisplay(value, space = 2) {
  return JSON.stringify(
    value,
    (_key, nestedValue) => {
      if (typeof nestedValue === 'function') {
        return nestedValue.toString();
      }
      if (typeof nestedValue === 'undefined') {
        return null;
      }
      return nestedValue;
    },
    space
  );
}

/**
 * 记录嵌套字符串原文，并返回继续递归的解析结果
 * @param {string} path
 * @param {string} original
 * @param {any} parsed
 * @param {{ expandedCount: number }} counter
 * @param {number} depth
 * @returns {any}
 */
function registerNestedStringExpansion(path, original, parsed, counter, depth) {
  counter.expandedCount += 1;
  nestedStringRestoreMap.set(path, original);
  return deepFormatJsonValue(parsed, counter, path, depth + 1);
}

/**
 * 递归格式化：将可解析的嵌套字符串展开为对象，便于阅读；并记录原文以便压缩还原
 * @param {any} value
 * @param {{ expandedCount: number }} counter
 * @param {string} [path]
 * @param {number} [depth]
 * @returns {any}
 */
function deepFormatJsonValue(value, counter, path = '', depth = 0) {
  if (depth > 30) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      deepFormatJsonValue(item, counter, joinJsonPath(path, index), depth + 1)
    );
  }

  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const result = {};
    Object.entries(value).forEach(([key, child]) => {
      result[key] = deepFormatJsonValue(child, counter, joinJsonPath(path, key), depth + 1);
    });
    return result;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  // 整段就是 JSON / JS 对象字符串 → 展开为对象
  const directParsed = parseStructuredData(trimmed);
  if (directParsed !== null && typeof directParsed === 'object') {
    return registerNestedStringExpansion(path, value, directParsed, counter, depth);
  }

  // jsCode：注释/赋值 + 对象 → 展开对象，记住原文
  const fragment = extractBalancedJsonFragment(value);
  if (!fragment || fragment.parsed === null || typeof fragment.parsed !== 'object') {
    return value;
  }

  return registerNestedStringExpansion(path, value, fragment.parsed, counter, depth);
}

/**
 * 压缩前还原：已展开的嵌套路径直接回写格式化前的原文
 * @param {any} value
 * @param {{ restoredCount: number }} counter
 * @param {string} [path]
 * @param {number} [depth]
 * @returns {any}
 */
function deepRestoreJsonValue(value, counter, path = '', depth = 0) {
  if (depth > 30) {
    return value;
  }

  if (nestedStringRestoreMap.has(path)) {
    counter.restoredCount += 1;
    return nestedStringRestoreMap.get(path);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      deepRestoreJsonValue(item, counter, joinJsonPath(path, index), depth + 1)
    );
  }

  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const result = {};
    Object.entries(value).forEach(([key, child]) => {
      result[key] = deepRestoreJsonValue(child, counter, joinJsonPath(path, key), depth + 1);
    });
    return result;
  }

  return value;
}

/**
 * 格式化 JSON：解析嵌套字符串为对象（可读），压缩时可还原
 */
function handleFormatJson() {
  const text = valueInput.value.trim();
  if (!text) {
    setActionStatus('没有可格式化的内容', 'empty');
    return;
  }

  try {
    const parsed = JSON.parse(text);
    // 先清旧状态，再保留本次格式化前原文
    clearFormatRestoreState();
    preFormatRootText = text;
    const counter = { expandedCount: 0 };
    const formatted = deepFormatJsonValue(parsed, counter);
    // 用展示序列化，避免箭头函数等被普通 JSON.stringify 丢弃
    valueInput.value = stringifyForDisplay(formatted, 2);
    autoResizeValueInput();
    updateValueMeta();
    if (counter.expandedCount > 0) {
      formatExpandActive = true;
      formatRestoreMapBackup = new Map(nestedStringRestoreMap);
      setActionStatus(
        `已递归格式化（解析 ${counter.expandedCount} 处嵌套对象；写入前会自动还原，不会写展开态）`,
        'success'
      );
    } else {
      preFormatRootText = '';
      formatExpandActive = false;
      formatRestoreMapBackup = null;
      setActionStatus('已格式化 JSON', 'success');
    }
  } catch {
    clearFormatRestoreState();
    setActionStatus('不是合法 JSON，无法格式化', 'error');
  }
}

/**
 * 压缩 JSON：若有格式化还原表，先还原嵌套字符串再压缩
 */
function handleCompressJson() {
  const text = valueInput.value.trim();
  if (!text) {
    setActionStatus('没有可压缩的内容', 'empty');
    return;
  }

  try {
    const restoreMap = getActiveFormatRestoreMap();
    const parsed = JSON.parse(text);
    const counter = { restoredCount: 0 };
    let restored = parsed;
    if (restoreMap && restoreMap.size > 0) {
      const previousMap = nestedStringRestoreMap;
      nestedStringRestoreMap = restoreMap;
      try {
        restored = deepRestoreJsonValue(parsed, counter);
      } finally {
        nestedStringRestoreMap = previousMap;
      }
    } else if (formatExpandActive && preFormatRootText) {
      valueInput.value = JSON.stringify(JSON.parse(preFormatRootText));
      autoResizeValueInput();
      updateValueMeta();
      clearFormatRestoreState();
      setActionStatus('还原表失效，已回退格式化前原文并压缩', 'success');
      return;
    }
    valueInput.value = JSON.stringify(restored);
    autoResizeValueInput();
    updateValueMeta();
    clearFormatRestoreState();
    if (counter.restoredCount > 0) {
      setActionStatus(`已压缩并还原 ${counter.restoredCount} 处嵌套字符串，可安全写入`, 'success');
    } else {
      setActionStatus('已压缩 JSON', 'success');
    }
  } catch {
    setActionStatus('不是合法 JSON，无法压缩', 'error');
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
  clearNestedStringRestoreMap();
  setActionStatus('已清空', '');
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
    ...historyFields,
    ...lastKeyFields,
    ...lastValueFields,
  ]);

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
  toggleHistoryBtn.addEventListener('click', toggleHistoryPanel);
  browseKeysBtn.addEventListener('click', toggleKeysPanel);
  refreshKeysBtn.addEventListener('click', async () => {
    setStatus('刷新中...', '');
    try {
      await refreshPageKeys(true);
      if (currentStorageType === STORAGE_TYPES.cookie) {
        const httpOnlyCount = Object.values(cookieDetailCache).filter((item) => item.httpOnly).length;
        setStatus(
          `共 ${pageKeyCache.length} 个 cookie（HttpOnly ${httpOnlyCount}）`,
          pageKeyCache.length ? 'success' : 'empty'
        );
      } else {
        setStatus(`共 ${pageKeyCache.length} 个 key`, pageKeyCache.length ? 'success' : 'empty');
      }
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
      const decodedKey = decodeURIComponent(item.dataset.key);
      if (currentStorageType === STORAGE_TYPES.cookie) {
        handleSelectCookieListKey(decodedKey);
      } else {
        handleSelectHistoryKey(decodedKey);
      }
    } catch {
      if (currentStorageType === STORAGE_TYPES.cookie) {
        handleSelectCookieListKey(item.dataset.key);
      } else {
        handleSelectHistoryKey(item.dataset.key);
      }
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
    if (suggestBlurTimer) {
      clearTimeout(suggestBlurTimer);
      suggestBlurTimer = null;
    }
    updateKeySuggest(true);
  });
  storageKeyInput.addEventListener('blur', () => {
    if (suggestBlurTimer) {
      clearTimeout(suggestBlurTimer);
    }
    suggestBlurTimer = setTimeout(() => {
      // 失焦后若焦点又回到输入框（如点清空按钮），不隐藏
      if (isStorageKeyInputFocused()) {
        return;
      }
      hideKeySuggest();
    }, 180);
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
    if (item.classList.contains('is-muted')) {
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
  syncKeysPanelButton();
  syncHistoryPanelVisibility();

  // 打开弹窗时自动读取当前 key；失败由 handleRead 展示错误
  if (storageKeyInput.value.trim()) {
    await handleRead();
  }
}

initPopup();

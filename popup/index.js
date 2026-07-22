const STORAGE_TYPES = {
  localStorage: 'localStorage',
  sessionStorage: 'sessionStorage',
  cookie: 'cookie',
};

const DEFAULT_STORAGE_TYPE = STORAGE_TYPES.localStorage;
const LAST_TYPE_STORAGE = 'last-storage-type';
const HISTORY_LIMIT = 10;
const DIFF_PREVIEW_LIMIT = 240;
/** Chrome 插件 popup 高度实际上限 */
const CHROME_POPUP_HEIGHT_LIMIT = 600;

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

const storageTypeTabsEl = document.getElementById('storageTypeTabs');
const keysFilterInput = document.getElementById('keysFilterInput');
const refreshKeysBtn = document.getElementById('refreshKeysBtn');
const viewAllJsonBtn = document.getElementById('viewAllJsonBtn');
const editAllJsonBtn = document.getElementById('editAllJsonBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const importFileInput = document.getElementById('importFileInput');
const cookieOptionsEl = document.getElementById('cookieOptions');
const cookiePathInput = document.getElementById('cookiePath');
const cookieMaxAgeInput = document.getElementById('cookieMaxAge');
const cookieDomainInput = document.getElementById('cookieDomain');
const cookieSameSiteSelect = document.getElementById('cookieSameSite');
const cookieSecureCheckbox = document.getElementById('cookieSecure');
const cookieHttpOnlyCheckbox = document.getElementById('cookieHttpOnly');
const storageTableBody = document.getElementById('storageTableBody');
const keysEmptyTipEl = document.getElementById('keysEmptyTip');
const addRowBtn = document.getElementById('addRowBtn');
const statusTextEl = document.getElementById('statusText');
const confirmDialog = document.getElementById('confirmDialog');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmBodyEl = document.getElementById('confirmBody');
const confirmOkBtn = document.getElementById('confirmOkBtn');
const jsonDialog = document.getElementById('jsonDialog');
const jsonDialogTitleEl = document.getElementById('jsonDialogTitle');
const jsonDialogKeyEl = document.getElementById('jsonDialogKey');
const jsonDialogEditor = document.getElementById('jsonDialogEditor');
const jsonDialogMetaEl = document.getElementById('jsonDialogMeta');
const jsonFormatBtn = document.getElementById('jsonFormatBtn');
const jsonCompressBtn = document.getElementById('jsonCompressBtn');
const jsonCopyBtn = document.getElementById('jsonCopyBtn');
const jsonPasteBtn = document.getElementById('jsonPasteBtn');
const jsonClearBtn = document.getElementById('jsonClearBtn');
const jsonSaveBtn = document.getElementById('jsonSaveBtn');
const jsonDeleteBtn = document.getElementById('jsonDeleteBtn');

/** @type {string} */
let currentStorageType = DEFAULT_STORAGE_TYPE;
/** 读写/删除互斥锁 */
let isBusy = false;
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

/**
 * 表格行模型
 * @typedef {{
 *   rowId: string,
 *   originKey: string | null,
 *   cacheKey: string | null,
 *   isDraft: boolean,
 *   key: string,
 *   value: string,
 * }} TableRowModel
 */

/** @type {TableRowModel[]} */
let tableRows = [];
/** 当前选中行 */
let activeRowId = null;
/** 行 id 自增 */
let rowIdSeq = 0;
/** 筛选关键字 */
let filterKeyword = '';

/**
 * 递归格式化还原表：路径 -> { prefix, suffix, original }
 * @type {Map<string, { prefix: string, suffix: string, original: string }>}
 */
let nestedStringRestoreMap = new Map();
/** 是否处于「已递归展开、尚未还原」状态 */
let formatExpandActive = false;
/** 格式化展开后是否被用户改过 */
let formatExpandDirty = false;
/** 格式化前的整段原文 */
let preFormatRootText = '';
/**
 * 格式化时的还原表备份
 * @type {Map<string, { prefix: string, suffix: string, original: string }> | null}
 */
let formatRestoreMapBackup = null;
/** 格式化状态绑定的行 id（全局一份） */
let formatBoundRowId = null;
/** JSON 弹窗当前绑定的行 id（全部模式为 null） */
let jsonDialogRowId = null;
/** JSON 弹窗模式：view | edit */
let jsonDialogMode = 'view';
/** JSON 弹窗作用域：row 单行 | all 表格全部 */
let jsonDialogScope = 'row';
/** 全部模式格式化态占位 id */
const JSON_ALL_FORMAT_ID = '__all_json__';

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
 * 在页面上下文中清空 localStorage / sessionStorage
 * @param {string} storageType
 */
function clearPageStorage(storageType) {
  const routeInfo = {
    href: window.location.href,
    hash: window.location.hash,
    pathname: window.location.pathname,
    origin: window.location.origin,
  };

  if (storageType === 'localStorage') {
    const before = window.localStorage.length;
    window.localStorage.clear();
    return {
      ...routeInfo,
      clearedCount: before,
      success: window.localStorage.length === 0,
      remainCount: window.localStorage.length,
    };
  }

  if (storageType === 'sessionStorage') {
    const before = window.sessionStorage.length;
    window.sessionStorage.clear();
    return {
      ...routeInfo,
      clearedCount: before,
      success: window.sessionStorage.length === 0,
      remainCount: window.sessionStorage.length,
    };
  }

  throw new Error('clearPageStorage 仅支持 localStorage / sessionStorage');
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
 * 构造 remove/set 时附带的 partitionKey（Chrome 119+ 分区 Cookie）
 * @param {chrome.cookies.Cookie | { partitionKey?: chrome.cookies.CookiePartitionKey } | null | undefined} cookie
 * @returns {{ partitionKey?: chrome.cookies.CookiePartitionKey }}
 */
function buildPartitionKeyField(cookie) {
  if (cookie && cookie.partitionKey && typeof cookie.partitionKey === 'object') {
    return { partitionKey: cookie.partitionKey };
  }
  return {};
}

/**
 * __Host- / __Secure- 前缀 cookie 的强制约束
 * @param {string} key
 * @param {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string, httpOnly: boolean, expirationDate?: number | null }} options
 * @returns {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string, httpOnly: boolean, expirationDate?: number | null, prefixTip: string }}
 */
function enforceCookieNamePrefixRules(key, options) {
  const next = { ...options, prefixTip: '' };
  if (key.startsWith('__Host-')) {
    // RFC：必须 Secure、Path=/、且不能带 Domain
    next.secure = true;
    next.path = '/';
    next.domain = '';
    next.prefixTip = '__Host- 前缀已强制 Secure、Path=/、无 Domain';
    cookieSecureCheckbox.checked = true;
    cookiePathInput.value = '/';
    cookieDomainInput.value = '';
  } else if (key.startsWith('__Secure-')) {
    next.secure = true;
    next.prefixTip = '__Secure- 前缀已强制 Secure';
    cookieSecureCheckbox.checked = true;
  }
  return next;
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

  const normalizedOptions = enforceCookieNamePrefixRules(key, options);
  let sameSite = mapSameSiteToApi(normalizedOptions.sameSite);
  let secure = Boolean(normalizedOptions.secure);
  const httpOnly = Boolean(normalizedOptions.httpOnly);

  if (sameSite === 'no_restriction') {
    secure = true;
    cookieSecureCheckbox.checked = true;
  }

  const nextPath = normalizedOptions.path || '/';
  const nextDomainNorm = (normalizedOptions.domain || '').replace(/^\./, '');

  // 写入前清理冲突项，并记住同 identity 的 partitionKey（分区 Cookie 必须带上才能改到同一条）
  const existingCookies = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  /** @type {chrome.cookies.Cookie | null} */
  let sameIdentityCookie = null;
  for (const cookie of existingCookies) {
    const oldPath = cookie.path || '/';
    const oldDomainNorm = cookie.hostOnly ? '' : String(cookie.domain || '').replace(/^\./, '');
    const isSameIdentity = oldPath === nextPath && oldDomainNorm === nextDomainNorm;
    if (isSameIdentity) {
      sameIdentityCookie = cookie;
    }
    if (conflictMode === 'replace-all-same-name' || isSameIdentity) {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: key,
        storeId: cookie.storeId,
        ...buildPartitionKeyField(cookie),
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
    ...buildPartitionKeyField(sameIdentityCookie),
  };

  if (normalizedOptions.domain) {
    details.domain = normalizedOptions.domain;
  }
  if (sameSite) {
    details.sameSite = sameSite;
  }
  if (
    normalizedOptions.maxAge !== null &&
    normalizedOptions.maxAge !== undefined &&
    Number.isFinite(normalizedOptions.maxAge)
  ) {
    details.expirationDate = Date.now() / 1000 + normalizedOptions.maxAge;
  } else if (
    normalizedOptions.expirationDate !== null &&
    normalizedOptions.expirationDate !== undefined &&
    Number.isFinite(normalizedOptions.expirationDate)
  ) {
    // 沿用读取时的绝对过期时间
    details.expirationDate = normalizedOptions.expirationDate;
  }
  if (storeId) {
    details.storeId = storeId;
  }

  const result = await chrome.cookies.set(details);
  const setError = chrome.runtime.lastError?.message || '';
  if (!result) {
    return {
      ...routeInfo,
      value: null,
      success: false,
      httpOnly,
      error: setError || 'chrome.cookies.set 返回空（可能被浏览器拒绝：Secure/SameSite/Domain/前缀规则等）',
      prefixTip: normalizedOptions.prefixTip,
    };
  }

  const actualHttpOnly = Boolean(result.httpOnly);
  const actualSecure = Boolean(result.secure);
  const attributeMismatch = actualHttpOnly !== httpOnly || actualSecure !== secure;

  cookieDetailCache[buildCookieCacheKey(result)] = result;
  applyCookieDetailsToForm(result);

  if (attributeMismatch) {
    return {
      ...routeInfo,
      value: result.value,
      success: false,
      httpOnly: actualHttpOnly,
      cookie: result,
      attributeMismatch: true,
      expectedHttpOnly: httpOnly,
      actualHttpOnly,
      expectedSecure: secure,
      actualSecure,
      prefixTip: normalizedOptions.prefixTip,
      error: `属性未按预期生效：HttpOnly 期望 ${httpOnly} / 实际 ${actualHttpOnly}，Secure 期望 ${secure} / 实际 ${actualSecure}`,
    };
  }

  return {
    ...routeInfo,
    value: result.value,
    success: result.value === value,
    httpOnly: actualHttpOnly,
    cookie: result,
    prefixTip: normalizedOptions.prefixTip,
  };
}

/**
 * 按表单 Path/Domain 筛选待删 cookie（同名多 Path 时只删当前目标）
 * @param {chrome.cookies.Cookie[]} cookies
 * @param {{ path?: string, domain?: string }} options
 * @returns {chrome.cookies.Cookie[]}
 */
function filterCookiesByDeleteOptions(cookies, options = {}) {
  const optPath = options.path || '/';
  const optDomainNorm =
    typeof options.domain === 'string' ? options.domain.trim().replace(/^\./, '') : '';

  const samePath = cookies.filter((cookie) => (cookie.path || '/') === optPath);
  if (!samePath.length) {
    return [];
  }

  if (optDomainNorm) {
    return samePath.filter((cookie) => {
      const cookieDomainNorm = cookie.hostOnly
        ? ''
        : String(cookie.domain || '').replace(/^\./, '');
      return cookieDomainNorm === optDomainNorm;
    });
  }

  // Domain 为空：优先 host-only（与读取回填一致）；否则同 Path 全部
  const hostOnlyMatches = samePath.filter((cookie) => cookie.hostOnly);
  return hostOnlyMatches.length ? hostOnlyMatches : samePath;
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
  // 缓存 key 为 name+path+domain 复合键，不能直接用 name 取值
  const cachedByName = Object.values(cookieDetailCache).filter((cookie) => cookie?.name === key);
  const allSameName = matchedCookies.length ? matchedCookies : cachedByName;
  // 有 Path/Domain 时只删匹配项，避免误删同名其他 Path
  const hasDeleteHint =
    (typeof options.path === 'string' && options.path.trim() !== '') ||
    (typeof options.domain === 'string' && options.domain.trim() !== '');
  const targets = hasDeleteHint
    ? filterCookiesByDeleteOptions(allSameName, options)
    : allSameName;

  // 同名存在但 Path/Domain 对不上：直接失败，提示用户调整表单
  if (hasDeleteHint && !targets.length && allSameName.length) {
    return { ...routeInfo, success: false };
  }

  if (!targets.length) {
    const storeId = tab.id ? await getTabCookieStoreId(tab.id) : undefined;
    const path = options.path || '/';
    try {
      const parsed = new URL(tab.url || '');
      const domain = (options.domain || parsed.hostname).replace(/^\./, '');
      for (const protocol of ['https:', 'http:']) {
        await chrome.cookies.remove({
          url: `${protocol}//${domain}${path}`,
          name: key,
          ...(storeId ? { storeId } : {}),
        });
      }
    } catch {
      await chrome.cookies.remove({
        url: normalizeCookieQueryUrl(tab.url || ''),
        name: key,
        ...(storeId ? { storeId } : {}),
      });
    }
  } else {
    for (const cookie of targets) {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: key,
        storeId: cookie.storeId,
        ...buildPartitionKeyField(cookie),
      });
    }
  }

  // 仅检查「本次目标」是否删干净，同名其他 Path 允许保留
  const remainSameName = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  const remainTargets = hasDeleteHint
    ? filterCookiesByDeleteOptions(remainSameName, options)
    : remainSameName;

  if (remainTargets.length) {
    for (const cookie of remainTargets) {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: key,
        storeId: cookie.storeId,
        ...buildPartitionKeyField(cookie),
      });
    }
  }

  const remainFinalSameName = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  const remainFinal = hasDeleteHint
    ? filterCookiesByDeleteOptions(remainFinalSameName, options)
    : remainFinalSameName;

  if (!remainFinal.length) {
    Object.keys(cookieDetailCache).forEach((cacheKey) => {
      const cached = cookieDetailCache[cacheKey];
      if (!cached || cached.name !== key) {
        return;
      }
      if (!hasDeleteHint || filterCookiesByDeleteOptions([cached], options).length) {
        delete cookieDetailCache[cacheKey];
      }
    });
  }
  return { ...routeInfo, success: remainFinal.length === 0 };
}

/**
 * 清空当前页全部 cookie（按 Path/Domain 精确删除，含 HttpOnly）
 * @param {chrome.tabs.Tab} tab
 */
async function clearAllCookiesViaApi(tab) {
  const routeInfo = buildRouteInfoFromTab(tab);
  await ensureCookieHostPermission(tab.url || '');

  const pageData = await listCookiesViaApi(tab);
  const cookies = Array.isArray(pageData.cookies)
    ? pageData.cookies
    : Object.values(cookieDetailCache).filter(Boolean);
  let successCount = 0;
  let failCount = 0;

  for (const cookie of cookies) {
    if (!cookie?.name) {
      failCount += 1;
      continue;
    }
    try {
      const result = await deleteCookieViaApi(tab, cookie.name, {
        path: cookie.path || '/',
        domain: cookie.hostOnly ? '' : cookie.domain || '',
      });
      if (result.success) {
        successCount += 1;
      } else {
        failCount += 1;
      }
    } catch {
      failCount += 1;
    }
  }

  return {
    ...routeInfo,
    successCount,
    failCount,
    total: cookies.length,
    success: failCount === 0,
  };
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

function showConfirmDialog(options) {
  const { title, body, okText = '确认', danger = false } = options;
  confirmTitleEl.textContent = title;
  confirmBodyEl.textContent = body;
  confirmOkBtn.textContent = okText;
  confirmOkBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  confirmDialog.classList.toggle('is-danger', Boolean(danger));

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
 * 尝试把文本格式化为缩进 JSON；失败则原样返回
 * @param {string} text
 * @returns {{ text: string, isJson: boolean }}
 */
function tryPrettyJsonText(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: raw, isJson: false };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return { text: stringifyForDisplay(parsed, 2), isJson: true };
  } catch {
    return { text: raw, isJson: false };
  }
}

/**
 * 更新 JSON 弹窗元信息
 * @param {string} text
 * @param {boolean} isJson
 */
function updateJsonDialogMeta(text, isJson) {
  const byteLength = new TextEncoder().encode(text).length;
  const scopeTip = jsonDialogScope === 'all' ? '全部数据' : '单行';
  const modeTip = jsonDialogMode === 'view' ? '只读查看' : '可编辑';
  const jsonTip = isJson ? '合法 JSON' : '非合法 JSON（按原文显示）';
  jsonDialogMetaEl.textContent = `${scopeTip} · ${modeTip} · ${jsonTip} · ${text.length} 字符 · ${byteLength} 字节`;
}

/**
 * 同步 JSON 弹窗控件显隐与标题
 */
function syncJsonDialogControls() {
  const isEdit = jsonDialogMode === 'edit';
  jsonDialogEditor.readOnly = !isEdit;
  jsonFormatBtn.hidden = !isEdit;
  jsonCompressBtn.hidden = !isEdit;
  jsonPasteBtn.hidden = !isEdit;
  jsonClearBtn.hidden = !isEdit;
  jsonSaveBtn.hidden = !isEdit;
  // 删除仅单行编辑有意义
  jsonDeleteBtn.hidden = !isEdit || jsonDialogScope !== 'row';
  if (jsonDialogScope === 'all') {
    jsonDialogTitleEl.textContent = isEdit ? '全部 JSON 编辑' : '全部 JSON 查看';
    jsonSaveBtn.textContent = '写入全部';
  } else {
    jsonDialogTitleEl.textContent = isEdit ? 'JSON 编辑' : 'JSON 查看';
    jsonSaveBtn.textContent = '保存';
  }
}

/**
 * 当前格式化态绑定目标（单行 rowId 或全部占位）
 * @returns {string | null}
 */
function getJsonDialogFormatTargetId() {
  if (jsonDialogScope === 'all') {
    return JSON_ALL_FORMAT_ID;
  }
  return jsonDialogRowId;
}

/**
 * 从表格收集全部条目（跳过空 key 草稿）；cookie 用 name 作 key（同名多 Path 后者覆盖）
 * @returns {Record<string, string>}
 */
function collectAllEntriesFromTable() {
  /** @type {Record<string, string>} */
  const entries = {};
  tableRows.forEach((row) => {
    syncRowModelFromDom(row.rowId);
    const key = row.key.trim();
    if (!key) {
      return;
    }
    // cookie 同名多 Path 时以最后一条为准，与导出兼容 data 一致
    entries[key] = row.value ?? '';
  });
  return entries;
}

/**
 * 将 entries 对象格式化为弹窗展示文本
 * @param {Record<string, string>} entries
 * @returns {{ text: string, isJson: boolean, count: number }}
 */
function stringifyAllEntriesForDialog(entries) {
  const count = Object.keys(entries).length;
  try {
    return {
      text: stringifyForDisplay(entries, 2),
      isJson: true,
      count,
    };
  } catch {
    return {
      text: JSON.stringify(entries, null, 2),
      isJson: true,
      count,
    };
  }
}

/**
 * 解析全部 JSON 编辑内容为 string 条目表
 * @param {string} rawText
 * @returns {Record<string, string>}
 */
function parseAllEntriesFromDialogText(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('内容为空');
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('根节点必须是 JSON 对象，例如 { "key": "value" }');
  }
  /** @type {Record<string, string>} */
  const entries = {};
  Object.keys(parsed).forEach((key) => {
    const trimmedKey = String(key).trim();
    if (!trimmedKey) {
      return;
    }
    const value = parsed[key];
    if (value === null || value === undefined) {
      entries[trimmedKey] = '';
      return;
    }
    if (typeof value === 'string') {
      // 字符串值若本身是合法 JSON，写入前自动压缩
      entries[trimmedKey] = compressTextIfJson(value).text;
      return;
    }
    // 对象/数组/数字/布尔：序列化为压缩字符串再写入存储
    entries[trimmedKey] = JSON.stringify(value);
  });
  return entries;
}

/**
 * 打开单行 JSON 查看 / 编辑弹窗
 * @param {string} rowId
 * @param {'view' | 'edit'} mode
 */
function openJsonDialog(rowId, mode) {
  syncRowModelFromDom(rowId);
  const row = tableRows.find((item) => item.rowId === rowId);
  if (!row) {
    return;
  }

  const sourceText = getRowValueTextarea(rowId)?.value ?? row.value ?? '';
  const pretty = tryPrettyJsonText(sourceText);

  // 打开编辑时清掉旧格式化态，避免保存时误用上次的 preFormatRootText
  clearFormatStateForUi();

  jsonDialogScope = 'row';
  jsonDialogRowId = rowId;
  jsonDialogMode = mode;
  jsonDialogKeyEl.textContent = row.key.trim()
    ? `Key：${row.key.trim()}`
    : 'Key：（未填写）';
  jsonDialogEditor.value = pretty.text;
  syncJsonDialogControls();
  updateJsonDialogMeta(pretty.text, pretty.isJson);

  if (!jsonDialog.open) {
    jsonDialog.showModal();
  }
  if (mode === 'edit') {
    jsonDialogEditor.focus();
  }
}

/**
 * 打开表格全部数据的 JSON 查看 / 编辑弹窗
 * @param {'view' | 'edit'} mode
 */
function openAllJsonDialog(mode) {
  const entries = collectAllEntriesFromTable();
  const pretty = stringifyAllEntriesForDialog(entries);
  const typeLabel = getStorageTypeLabel(currentStorageType);

  jsonDialogScope = 'all';
  jsonDialogRowId = null;
  jsonDialogMode = mode;
  clearFormatStateForUi();
  jsonDialogKeyEl.textContent = `${typeLabel} · 共 ${pretty.count} 个 key（值为字符串；编辑时可写对象，写入时会自动序列化）`;
  jsonDialogEditor.value = pretty.text;
  syncJsonDialogControls();
  updateJsonDialogMeta(pretty.text, pretty.isJson);

  if (!jsonDialog.open) {
    jsonDialog.showModal();
  }
  if (mode === 'edit') {
    jsonDialogEditor.focus();
  }
}

/**
 * 关闭 JSON 弹窗
 */
function closeJsonDialog() {
  if (jsonDialog.open) {
    jsonDialog.close('cancel');
  }
  jsonDialogRowId = null;
  jsonDialogMode = 'view';
  jsonDialogScope = 'row';
}

/**
 * JSON 弹窗内格式化（仅编辑模式）
 */
function handleJsonDialogFormat() {
  if (jsonDialogMode !== 'edit') {
    return;
  }
  const targetId = getJsonDialogFormatTargetId();
  if (!targetId) {
    return;
  }
  const text = jsonDialogEditor.value.trim();
  if (!text) {
    setStatus('没有可格式化的内容', 'empty');
    return;
  }
  try {
    ensureFormatBoundToRow(targetId);
    const parsed = JSON.parse(text);
    clearFormatRestoreState();
    preFormatRootText = text;
    formatBoundRowId = targetId;
    const counter = { expandedCount: 0 };
    const formatted = deepFormatJsonValue(parsed, counter);
    jsonDialogEditor.value = stringifyForDisplay(formatted, 2);
    if (counter.expandedCount > 0) {
      formatExpandActive = true;
      formatExpandDirty = false;
      formatRestoreMapBackup = new Map(nestedStringRestoreMap);
      updateJsonDialogMeta(jsonDialogEditor.value, true);
      setStatus(
        `已递归格式化（解析 ${counter.expandedCount} 处嵌套对象）`,
        'success'
      );
    } else {
      preFormatRootText = '';
      formatExpandActive = false;
      formatExpandDirty = false;
      formatRestoreMapBackup = null;
      updateJsonDialogMeta(jsonDialogEditor.value, true);
      setStatus('已格式化 JSON', 'success');
    }
  } catch {
    clearFormatStateForUi();
    updateJsonDialogMeta(jsonDialogEditor.value, false);
    setStatus('不是合法 JSON，无法格式化', 'error');
  }
}

/**
 * JSON 弹窗内压缩
 */
function handleJsonDialogCompress() {
  if (jsonDialogMode !== 'edit') {
    return;
  }
  const targetId = getJsonDialogFormatTargetId();
  if (!targetId) {
    return;
  }
  const text = jsonDialogEditor.value.trim();
  if (!text) {
    setStatus('没有可压缩的内容', 'empty');
    return;
  }
  try {
    ensureFormatBoundToRow(targetId);
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
    } else if (formatExpandActive && preFormatRootText && !formatExpandDirty) {
      jsonDialogEditor.value = JSON.stringify(JSON.parse(preFormatRootText));
      clearFormatStateForUi();
      updateJsonDialogMeta(jsonDialogEditor.value, true);
      setStatus('还原表失效，已回退格式化前原文并压缩', 'success');
      return;
    }
    jsonDialogEditor.value = JSON.stringify(restored);
    const keptEdits = formatExpandDirty && counter.restoredCount > 0;
    clearFormatStateForUi();
    updateJsonDialogMeta(jsonDialogEditor.value, true);
    if (counter.restoredCount > 0) {
      setStatus(
        keptEdits
          ? `已压缩并还原 ${counter.restoredCount} 处嵌套字符串（已保留编辑）`
          : `已压缩并还原 ${counter.restoredCount} 处嵌套字符串`,
        'success'
      );
    } else {
      setStatus('已压缩 JSON', 'success');
    }
  } catch {
    updateJsonDialogMeta(jsonDialogEditor.value, false);
    setStatus('不是合法 JSON，无法压缩', 'error');
  }
}

/**
 * 复制 JSON 弹窗内容
 */
async function handleJsonDialogCopy() {
  const text = jsonDialogEditor.value;
  if (!text) {
    setStatus('没有可复制的内容', 'empty');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      jsonDialogEditor.focus();
      jsonDialogEditor.select();
      document.execCommand('copy');
    }
    setStatus('已复制 JSON 内容', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '复制失败', 'error');
  }
}

/**
 * 粘贴到 JSON 弹窗编辑器（仅编辑模式）
 */
async function handleJsonDialogPaste() {
  if (jsonDialogMode !== 'edit') {
    return;
  }
  try {
    let text = '';
    if (navigator.clipboard?.readText) {
      text = await navigator.clipboard.readText();
    } else {
      setStatus('当前环境不支持读取剪贴板，请在编辑框内按 Ctrl/Cmd + V', 'error');
      jsonDialogEditor.focus();
      return;
    }
    if (!text) {
      setStatus('剪贴板为空（或非文本内容）', 'empty');
      return;
    }
    const formatTargetId = getJsonDialogFormatTargetId();
    if (formatBoundRowId && formatTargetId && formatBoundRowId === formatTargetId) {
      clearFormatStateForUi();
    }
    jsonDialogEditor.value = text;
    let isJson = false;
    try {
      JSON.parse(text.trim());
      isJson = true;
    } catch {
      isJson = false;
    }
    updateJsonDialogMeta(text, isJson);
    setStatus(`已粘贴，长度 ${text.length}`, 'success');
    jsonDialogEditor.focus();
  } catch {
    setStatus(
      '粘贴失败：请重新加载扩展后再试，或直接在编辑框按 Ctrl/Cmd + V',
      'error'
    );
    jsonDialogEditor.focus();
  }
}

/**
 * 若文本是合法 JSON，则压缩为一行；否则原样返回
 * @param {string} text
 * @returns {{ text: string, minified: boolean }}
 */
function compressTextIfJson(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: raw, minified: false };
  }
  try {
    return { text: JSON.stringify(JSON.parse(trimmed)), minified: true };
  } catch {
    return { text: raw, minified: false };
  }
}

/**
 * 将弹窗内容写回表格行（合法 JSON 强制压缩；不直接写入页面存储）
 * @param {{ closeDialog?: boolean, silentStatus?: boolean }} [options]
 * @returns {string | null} 成功返回 rowId
 */
function applyJsonDialogToRow(options = {}) {
  const { closeDialog = true, silentStatus = false } = options;
  if (jsonDialogMode !== 'edit' || jsonDialogScope !== 'row' || !jsonDialogRowId) {
    return null;
  }

  // 先固定 rowId / 原文，避免 close 事件把状态清空后取不到
  const rowId = jsonDialogRowId;
  const row = tableRows.find((item) => item.rowId === rowId);
  let text = jsonDialogEditor.value;

  // 若当前行处于嵌套展开态，先按还原表折叠，再压缩
  const restoreMap =
    formatBoundRowId === rowId || formatBoundRowId === JSON_ALL_FORMAT_ID
      ? getActiveFormatRestoreMap()
      : null;
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
        }
      } finally {
        nestedStringRestoreMap = previousMap;
      }
    } catch {
      // 还原失败则继续用当前文本压缩
    }
  }

  // 不走 prepareValueForWrite：避免「未编辑回退 preFormatRootText」干扰当前内容
  const compressed = compressTextIfJson(text);
  text = compressed.text;

  if (row) {
    row.value = text;
  }

  const textarea = getRowValueTextarea(rowId);
  if (textarea) {
    textarea.value = text;
  } else if (!row) {
    setStatus('目标行不存在，无法写回', 'error');
    if (closeDialog) {
      closeJsonDialog();
    }
    return null;
  } else {
    // 行被筛选隐藏：写回模型后重渲染
    renderStorageTable();
  }

  clearFormatStateForUi();
  if (closeDialog) {
    closeJsonDialog();
  }
  setActiveRow(rowId, { syncCookie: true });
  if (!silentStatus) {
    setStatus(
      compressed.minified ? '已压缩并写回行' : '已写回行（非合法 JSON，未压缩）',
      compressed.minified ? 'success' : 'empty'
    );
  }
  return rowId;
}

/**
 * 将全部 JSON 批量写入页面存储（只覆盖对象中出现的 key，不删除缺失 key）
 */
async function handleJsonDialogApplyAll() {
  if (jsonDialogMode !== 'edit' || jsonDialogScope !== 'all' || isBusy) {
    return;
  }

  let entries;
  try {
    // 写入前若处于展开态，先按还原逻辑压缩
    const prepared = prepareValueForWrite(jsonDialogEditor.value);
    entries = parseAllEntriesFromDialogText(prepared.text);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'JSON 解析失败', 'error');
    return;
  }

  // 拒绝空字符串值（与单行写入一致）
  const emptyKeys = Object.keys(entries).filter((key) => entries[key] === '');
  if (emptyKeys.length) {
    setStatus(
      `存在空值 key，无法写入：${emptyKeys.slice(0, 5).join(', ')}${emptyKeys.length > 5 ? '…' : ''}（清空请用删除）`,
      'error'
    );
    return;
  }

  const keys = Object.keys(entries);
  if (!keys.length) {
    setStatus('没有可写入的 key', 'empty');
    return;
  }

  const preview = keys
    .slice(0, 8)
    .map((key) => `- ${key}（${entries[key].length} 字符）`)
    .join('\n');
  const moreTip = keys.length > 8 ? `\n…共 ${keys.length} 条` : '';
  const cookieTip =
    currentStorageType === STORAGE_TYPES.cookie
      ? '\n\nCookie 将使用上方属性栏的 Path/Domain 等设置批量写入。'
      : '';

  const confirmed = await showConfirmDialog({
    title: `确认写入全部到 ${getStorageTypeLabel(currentStorageType)}？`,
    body: `将写入 / 覆盖以下 key（不会删除未出现在 JSON 中的 key）：\n${preview}${moreTip}${cookieTip}`,
    okText: '确认写入',
    danger: true,
  });
  if (!confirmed) {
    setStatus('已取消写入全部', 'empty');
    return;
  }

  setBusy(true);
  setStatus('批量写入中...');
  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);
    const cookieOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : {};

    let result;
    if (currentStorageType === STORAGE_TYPES.cookie) {
      result = await writeCookiesBatchViaApi(tab, entries, cookieOptions);
    } else {
      result = await executeInTab(tab.id, writePageStorageBatch, [
        currentStorageType,
        entries,
        cookieOptions,
      ]);
    }

    clearFormatStateForUi();
    closeJsonDialog();
    const successCount = result?.successCount ?? keys.length;
    const failCount = result?.failCount ?? 0;
    if (failCount > 0) {
      setStatus(`批量写入完成：成功 ${successCount}，失败 ${failCount}`, 'error');
    } else {
      setStatus(`已写入全部 ${successCount} 个 key`, 'success');
    }
    await refreshAndRenderTable();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '批量写入失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * JSON 弹窗「应用」：按作用域分流
 */
/**
 * 弹窗「保存」：单行=压缩写回行后写入页面存储；全部=写入全部
 */
async function handleJsonDialogSave() {
  if (jsonDialogMode !== 'edit') {
    return;
  }
  if (jsonDialogScope === 'all') {
    await handleJsonDialogApplyAll();
    return;
  }

  const rowId = jsonDialogRowId;
  if (!rowId) {
    setStatus('没有可保存的行', 'error');
    return;
  }

  // 先压缩写回表格行并关闭弹窗，再走行内保存（含确认）
  const appliedRowId = applyJsonDialogToRow({ closeDialog: true, silentStatus: true });
  if (!appliedRowId) {
    return;
  }
  await handleRowSave(appliedRowId);
}

/**
 * 弹窗「清空」：清空编辑器内容（不改页面存储）
 */
function handleJsonDialogClear() {
  if (jsonDialogMode !== 'edit') {
    return;
  }
  const formatTargetId = getJsonDialogFormatTargetId();
  if (formatBoundRowId && formatTargetId && formatBoundRowId === formatTargetId) {
    clearFormatStateForUi();
  }
  jsonDialogEditor.value = jsonDialogScope === 'all' ? '{\n}' : '';
  updateJsonDialogMeta(jsonDialogEditor.value, jsonDialogScope === 'all');
  setStatus('已清空编辑内容（尚未写入存储）', 'empty');
  jsonDialogEditor.focus();
}

/**
 * 弹窗「删除」：关闭弹窗后删除当前行对应存储
 */
async function handleJsonDialogDelete() {
  if (jsonDialogMode !== 'edit' || jsonDialogScope !== 'row' || !jsonDialogRowId) {
    return;
  }
  const rowId = jsonDialogRowId;
  closeJsonDialog();
  await handleRowDelete(rowId);
}

function normalizeHistoryList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, HISTORY_LIMIT);
}

function prepareValueForWrite(rawText) {
  let text = rawText;
  let restoredCount = 0;
  let usedFallback = false;
  let minified = false;
  const restoreMap = getActiveFormatRestoreMap();

  // 1) 按还原表折叠嵌套字符串
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
      // 继续后续逻辑
    }
  }

  // 2) 仅「未编辑」且还原失败时回退整段原文；已编辑绝不用原文盖掉改动
  if (restoredCount === 0 && preFormatRootText && !formatExpandDirty) {
    text = preFormatRootText;
    usedFallback = true;
  }

  // 3) 合法 JSON 一律压缩
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
 * @returns {Map<string, { prefix: string, suffix: string, original: string }> | null}
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
 * 清空格式化展开态与还原信息
 */
function clearFormatRestoreState() {
  nestedStringRestoreMap.clear();
  formatExpandActive = false;
  formatExpandDirty = false;
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
 * 记录嵌套字符串还原信息，并返回继续递归的解析结果
 * @param {string} path
 * @param {string} original
 * @param {any} parsed
 * @param {{ expandedCount: number }} counter
 * @param {number} depth
 * @param {string} [prefix]
 * @param {string} [suffix]
 * @returns {any}
 */
function registerNestedStringExpansion(
  path,
  original,
  parsed,
  counter,
  depth,
  prefix = '',
  suffix = ''
) {
  counter.expandedCount += 1;
  nestedStringRestoreMap.set(path, { prefix, suffix, original });
  return deepFormatJsonValue(parsed, counter, path, depth + 1);
}

/**
 * 递归格式化：将可解析的嵌套字符串展开为对象，便于阅读；并记录还原信息
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
    return registerNestedStringExpansion(path, value, directParsed, counter, depth, '', '');
  }

  // jsCode：注释/赋值 + 对象 → 展开对象，记住前后缀与原文
  const fragment = extractBalancedJsonFragment(value);
  if (!fragment || fragment.parsed === null || typeof fragment.parsed !== 'object') {
    return value;
  }

  return registerNestedStringExpansion(
    path,
    value,
    fragment.parsed,
    counter,
    depth,
    fragment.prefix,
    fragment.suffix
  );
}

/**
 * 压缩前还原：未编辑用原文；已编辑则按当前对象重序列化并保留 prefix/suffix
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

  const meta = nestedStringRestoreMap.get(path);

  // 未编辑：直接回写原文，避免函数等被重序列化丢失
  if (meta && !formatExpandDirty) {
    counter.restoredCount += 1;
    return meta.original;
  }

  // 已编辑或非还原路径：先递归子节点，再按需折叠
  let nextValue = value;
  if (Array.isArray(value)) {
    nextValue = value.map((item, index) =>
      deepRestoreJsonValue(item, counter, joinJsonPath(path, index), depth + 1)
    );
  } else if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const result = {};
    Object.entries(value).forEach(([key, child]) => {
      result[key] = deepRestoreJsonValue(child, counter, joinJsonPath(path, key), depth + 1);
    });
    nextValue = result;
  }

  if (meta && formatExpandDirty) {
    counter.restoredCount += 1;
    // 已是字符串说明该层已折叠（例如取消写入后残留），禁止再次 stringify 造成双重转义
    if (typeof nextValue === 'string') {
      return nextValue;
    }
    return `${meta.prefix}${JSON.stringify(nextValue)}${meta.suffix}`;
  }

  return nextValue;
}

function applyPopupMaxHeight() {
  const screenBasedHeight = Math.floor(window.screen.availHeight * 0.8);
  const maxHeight = Math.min(screenBasedHeight, CHROME_POPUP_HEIGHT_LIMIT);
  document.documentElement.style.setProperty('--popup-max-height', `${maxHeight}px`);
}


/**
 * 设置状态文案到 #statusText
 * @param {string} text
 * @param {'success' | 'error' | 'empty' | 'pending' | ''} [type]
 */
function setStatus(text, type = '') {
  const nextType = type || (text ? 'pending' : '');
  statusTextEl.textContent = text;
  statusTextEl.className = `status${nextType ? ` is-${nextType}` : ''}`;

  if (!text) {
    return;
  }

  if (nextType === 'error' || nextType === 'empty' || nextType === 'success') {
    statusTextEl.classList.remove('is-flash');
    void statusTextEl.offsetWidth;
    statusTextEl.classList.add('is-flash');
  }
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
 * 同步 Cookie 属性栏显隐
 */
function syncCookieBarVisibility() {
  cookieOptionsEl.hidden = currentStorageType !== STORAGE_TYPES.cookie;
}

/**
 * 设置读写互斥状态：busy 时禁用刷新/导入/导出/增加/行内保存删除
 * @param {boolean} busy
 */
function setBusy(busy) {
  isBusy = busy;
  refreshKeysBtn.disabled = busy;
  viewAllJsonBtn.disabled = busy;
  editAllJsonBtn.disabled = busy;
  exportBtn.disabled = busy;
  importBtn.disabled = busy;
  clearAllBtn.disabled = busy;
  addRowBtn.disabled = busy;
  storageTableBody.querySelectorAll('[data-action="save"], [data-action="delete"]').forEach((btn) => {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = busy;
    }
  });
}

/**
 * 将 key 写入历史（最近 10 条，去重置顶；UI 不展示历史面板）
 * @param {string} key
 */
async function pushKeyHistory(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) {
    return;
  }
  const historyField = getHistoryField(currentStorageType);
  const stored = await chrome.storage.local.get(historyField);
  const previousList = normalizeHistoryList(stored[historyField]);
  const nextList = [trimmed, ...previousList.filter((item) => item !== trimmed)].slice(0, HISTORY_LIMIT);

  await chrome.storage.local.set({
    [LAST_TYPE_STORAGE]: currentStorageType,
    [getLastKeyField(currentStorageType)]: trimmed,
    [historyField]: nextList,
  });
}

/**
 * 生成新行 id
 * @returns {string}
 */
function createRowId() {
  rowIdSeq += 1;
  return `row-${rowIdSeq}`;
}

/**
 * 按 cacheKey / key 查找 cookie 详情
 * @param {TableRowModel} row
 * @returns {chrome.cookies.Cookie | null}
 */
function getCookieDetailForRow(row) {
  if (row.cacheKey && cookieDetailCache[row.cacheKey]) {
    return cookieDetailCache[row.cacheKey];
  }
  if (row.originKey && cookieDetailCache[row.originKey]) {
    return cookieDetailCache[row.originKey];
  }
  return null;
}

/**
 * 从 list API 结果构建行模型列表
 * @param {{ keys?: string[], entries?: Record<string, string> }} pageData
 * @returns {TableRowModel[]}
 */
function buildRowsFromPageData(pageData) {
  const keys = Array.isArray(pageData.keys) ? pageData.keys : [];
  const entries =
    pageData.entries && typeof pageData.entries === 'object' ? pageData.entries : {};

  return keys.map((entryKey) => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const cookie = cookieDetailCache[entryKey];
      const name = cookie?.name || entryKey;
      return {
        rowId: createRowId(),
        originKey: name,
        cacheKey: entryKey,
        isDraft: false,
        key: name,
        value: entries[entryKey] ?? cookie?.value ?? '',
      };
    }
    return {
      rowId: createRowId(),
      originKey: entryKey,
      cacheKey: null,
      isDraft: false,
      key: entryKey,
      value: entries[entryKey] ?? '',
    };
  });
}

/**
 * 创建草稿空行
 * @returns {TableRowModel}
 */
function createDraftRow() {
  return {
    rowId: createRowId(),
    originKey: null,
    cacheKey: null,
    isDraft: true,
    key: '',
    value: '',
  };
}

/**
 * 行是否匹配筛选（草稿始终显示）
 * @param {TableRowModel} row
 * @returns {boolean}
 */
function isRowMatchFilter(row) {
  if (row.isDraft) {
    return true;
  }
  const keyword = filterKeyword.trim().toLowerCase();
  if (!keyword) {
    return true;
  }
  if (currentStorageType === STORAGE_TYPES.cookie) {
    const cookie = getCookieDetailForRow(row);
    const name = (cookie?.name || row.key || '').toLowerCase();
    const path = (cookie?.path || '/').toLowerCase();
    const domain = (cookie?.domain || '').toLowerCase();
    return (
      name.includes(keyword) ||
      path.includes(keyword) ||
      domain.includes(keyword) ||
      row.key.toLowerCase().includes(keyword)
    );
  }
  return row.key.toLowerCase().includes(keyword);
}

/**
 * 构建 cookie 行徽章 HTML（path / domain / HttpOnly / Secure）
 * @param {TableRowModel} row
 * @returns {string}
 */
function buildCookieBadgesHtml(row) {
  const cookie = getCookieDetailForRow(row);
  if (!cookie) {
    return '';
  }
  const badges = [];
  badges.push(
    `<span class="row-badge is-path" title="Path">${escapeHtml(cookie.path || '/')}</span>`
  );
  if (!cookie.hostOnly && cookie.domain) {
    badges.push(
      `<span class="row-badge is-domain" title="Domain">${escapeHtml(cookie.domain)}</span>`
    );
  }
  if (cookie.httpOnly) {
    badges.push('<span class="row-badge is-httponly">HttpOnly</span>');
  }
  if (cookie.secure) {
    badges.push('<span class="row-badge is-secure">Secure</span>');
  }
  return badges.join('');
}

/**
 * 渲染单行 HTML
 * @param {TableRowModel} row
 * @returns {string}
 */
function buildRowHtml(row) {
  const isActive = row.rowId === activeRowId;
  const classNames = [
    isActive ? 'is-active' : '',
    row.isDraft ? 'is-draft' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // cookie 行展示 path/domain 等徽章；草稿行固定展示「草稿」
  let badges = '';
  if (row.isDraft) {
    badges = '<span class="row-badge is-draft">草稿</span>';
  } else if (currentStorageType === STORAGE_TYPES.cookie) {
    badges = buildCookieBadgesHtml(row);
  }
  const badgesBlock = badges ? `<div class="row-badges">${badges}</div>` : '';

  return `<tr class="${classNames}" data-row-id="${escapeHtml(row.rowId)}">
    <td class="col-key">
      <div class="row-key-wrap">
        <input class="row-key" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(row.key)}" aria-label="Key" />
        ${badgesBlock}
      </div>
    </td>
    <td class="col-value">
      <textarea class="row-value" spellcheck="false" aria-label="值">${escapeHtml(row.value)}</textarea>
    </td>
    <td class="col-actions">
      <div class="row-actions">
        <button class="btn btn-ghost" type="button" data-action="edit-json" title="以 JSON 格式编辑">编辑</button>
        <button class="btn btn-ghost" type="button" data-action="copy" title="复制值">复制</button>
        <button class="btn btn-ghost" type="button" data-action="paste" title="粘贴到值">粘贴</button>
        <button class="btn btn-primary" type="button" data-action="save" ${isBusy ? 'disabled' : ''}>保存</button>
        <button class="btn btn-danger" type="button" data-action="delete" ${isBusy ? 'disabled' : ''}>删除</button>
      </div>
    </td>
  </tr>`;
}

/**
 * 从 DOM 行同步模型中的 key/value
 * @param {string} rowId
 */
function syncRowModelFromDom(rowId) {
  const row = tableRows.find((item) => item.rowId === rowId);
  const tr = storageTableBody.querySelector(`tr[data-row-id="${CSS.escape(rowId)}"]`);
  if (!row || !(tr instanceof HTMLTableRowElement)) {
    return;
  }
  const keyInput = tr.querySelector('.row-key');
  const valueInput = tr.querySelector('.row-value');
  if (keyInput instanceof HTMLInputElement) {
    row.key = keyInput.value;
  }
  if (valueInput instanceof HTMLTextAreaElement) {
    row.value = valueInput.value;
  }
}

/**
 * 获取行 DOM 内的 textarea
 * @param {string} rowId
 * @returns {HTMLTextAreaElement | null}
 */
function getRowValueTextarea(rowId) {
  const tr = storageTableBody.querySelector(`tr[data-row-id="${CSS.escape(rowId)}"]`);
  if (!(tr instanceof HTMLTableRowElement)) {
    return null;
  }
  const textarea = tr.querySelector('.row-value');
  return textarea instanceof HTMLTextAreaElement ? textarea : null;
}

/**
 * 获取行 DOM 内的 key input
 * @param {string} rowId
 * @returns {HTMLInputElement | null}
 */
function getRowKeyInput(rowId) {
  const tr = storageTableBody.querySelector(`tr[data-row-id="${CSS.escape(rowId)}"]`);
  if (!(tr instanceof HTMLTableRowElement)) {
    return null;
  }
  const input = tr.querySelector('.row-key');
  return input instanceof HTMLInputElement ? input : null;
}

/**
 * 若格式化状态绑定其他行，先清空
 * @param {string} rowId
 */
function ensureFormatBoundToRow(rowId) {
  if (formatBoundRowId && formatBoundRowId !== rowId) {
    clearFormatRestoreState();
    formatBoundRowId = null;
  }
}

/**
 * 清空格式化状态时同步解绑行
 */
function clearFormatStateForUi() {
  clearFormatRestoreState();
  formatBoundRowId = null;
}

/**
 * 渲染表格
 */
function renderStorageTable() {
  const visibleRows = tableRows.filter(isRowMatchFilter);
  storageTableBody.innerHTML = visibleRows.map((row) => buildRowHtml(row)).join('');

  const hasAnyRows = tableRows.length > 0;
  const hasVisible = visibleRows.length > 0;
  if (!hasAnyRows) {
    keysEmptyTipEl.hidden = false;
    keysEmptyTipEl.textContent = '暂无 key';
  } else if (!hasVisible) {
    keysEmptyTipEl.hidden = false;
    keysEmptyTipEl.textContent = '无匹配 key';
  } else {
    keysEmptyTipEl.hidden = true;
  }
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
  syncCookieBarVisibility();
}

/**
 * 将选中行的 cookie 属性回填到属性栏；草稿/无详情时保留栏内当前值（新增用默认）
 * @param {TableRowModel | null} row
 */
function syncCookieBarFromRow(row) {
  if (currentStorageType !== STORAGE_TYPES.cookie) {
    return;
  }
  if (!row || row.isDraft) {
    // 新增草稿：不覆盖用户已填的默认属性，仅清掉保留过期
    clearCookiePreservedExpiration();
    cookieMaxAgeInput.placeholder = '秒，空=会话/保持原过期';
    cookieMaxAgeInput.title =
      '留空：会话 cookie；若刚读取过带过期的 cookie，则保持原过期时间。填写秒数则按相对时间重写。';
    return;
  }
  const cookie = getCookieDetailForRow(row);
  if (cookie) {
    applyCookieDetailsToForm(cookie);
  }
}

/**
 * 设为当前操作行并同步 cookie 属性
 * @param {string | null} rowId
 * @param {{ syncCookie?: boolean }} [options]
 */
function setActiveRow(rowId, options = {}) {
  const { syncCookie = true } = options;
  activeRowId = rowId;
  storageTableBody.querySelectorAll('tr[data-row-id]').forEach((tr) => {
    if (!(tr instanceof HTMLTableRowElement)) {
      return;
    }
    tr.classList.toggle('is-active', tr.dataset.rowId === rowId);
  });
  if (syncCookie) {
    const row = tableRows.find((item) => item.rowId === rowId) || null;
    syncCookieBarFromRow(row);
  }
}

/**
 * 拉取全部 key+value 并渲染表格
 * @param {{ keepDrafts?: boolean, preferActiveKey?: string | null }} [options]
 */
async function refreshAndRenderTable(options = {}) {
  const { keepDrafts = false, preferActiveKey = null } = options;
  const preservedDrafts = keepDrafts ? tableRows.filter((row) => row.isDraft) : [];
  // 刷新前把草稿 DOM 值写回模型
  preservedDrafts.forEach((row) => syncRowModelFromDom(row.rowId));

  const previousActive = tableRows.find((row) => row.rowId === activeRowId) || null;
  const preferKey =
    preferActiveKey ||
    previousActive?.key ||
    previousActive?.originKey ||
    null;

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

  tableRows = [...buildRowsFromPageData(pageData), ...preservedDrafts];
  clearFormatStateForUi();

  let nextActiveId = null;
  if (preferKey) {
    const matched = tableRows.find(
      (row) =>
        (!row.isDraft &&
          (row.key === preferKey ||
            row.originKey === preferKey ||
            row.cacheKey === preferKey)) ||
        (row.isDraft && row.key === preferKey)
    );
    if (matched) {
      nextActiveId = matched.rowId;
    }
  }
  if (!nextActiveId && preservedDrafts.length) {
    nextActiveId = preservedDrafts[preservedDrafts.length - 1].rowId;
  }
  if (!nextActiveId && tableRows.length) {
    nextActiveId = tableRows[0].rowId;
  }

  activeRowId = nextActiveId;
  renderStorageTable();
  if (nextActiveId) {
    setActiveRow(nextActiveId, { syncCookie: true });
  } else if (currentStorageType === STORAGE_TYPES.cookie) {
    clearCookiePreservedExpiration();
  }

  return pageData;
}

/**
 * 追加草稿空行
 */
function handleAddRow() {
  if (isBusy) {
    return;
  }
  const draft = createDraftRow();
  tableRows.push(draft);
  activeRowId = draft.rowId;
  renderStorageTable();
  setActiveRow(draft.rowId, { syncCookie: true });
  const keyInput = getRowKeyInput(draft.rowId);
  if (keyInput) {
    keyInput.focus();
  }
  setStatus('已追加草稿行，填写后点保存写入', 'empty');
}

/**
 * 行内格式化
 * @param {string} rowId
 */
function handleRowFormat(rowId) {
  const textarea = getRowValueTextarea(rowId);
  if (!textarea) {
    return;
  }
  ensureFormatBoundToRow(rowId);
  const text = textarea.value.trim();
  if (!text) {
    setStatus('没有可格式化的内容', 'empty');
    return;
  }

  try {
    const parsed = JSON.parse(text);
    clearFormatRestoreState();
    preFormatRootText = text;
    formatBoundRowId = rowId;
    const counter = { expandedCount: 0 };
    const formatted = deepFormatJsonValue(parsed, counter);
    textarea.value = stringifyForDisplay(formatted, 2);
    syncRowModelFromDom(rowId);
    if (counter.expandedCount > 0) {
      formatExpandActive = true;
      formatExpandDirty = false;
      formatRestoreMapBackup = new Map(nestedStringRestoreMap);
      setStatus(
        `已递归格式化（解析 ${counter.expandedCount} 处嵌套对象；改内层后写入/压缩会保留修改）`,
        'success'
      );
    } else {
      preFormatRootText = '';
      formatExpandActive = false;
      formatExpandDirty = false;
      formatRestoreMapBackup = null;
      setStatus('已格式化 JSON', 'success');
    }
  } catch {
    clearFormatStateForUi();
    setStatus('不是合法 JSON，无法格式化', 'error');
  }
}

/**
 * 行内压缩
 * @param {string} rowId
 */
function handleRowCompress(rowId) {
  const textarea = getRowValueTextarea(rowId);
  if (!textarea) {
    return;
  }
  ensureFormatBoundToRow(rowId);
  const text = textarea.value.trim();
  if (!text) {
    setStatus('没有可压缩的内容', 'empty');
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
    } else if (formatExpandActive && preFormatRootText && !formatExpandDirty) {
      textarea.value = JSON.stringify(JSON.parse(preFormatRootText));
      syncRowModelFromDom(rowId);
      clearFormatStateForUi();
      setStatus('还原表失效，已回退格式化前原文并压缩', 'success');
      return;
    }
    textarea.value = JSON.stringify(restored);
    syncRowModelFromDom(rowId);
    const keptEdits = formatExpandDirty && counter.restoredCount > 0;
    clearFormatStateForUi();
    if (counter.restoredCount > 0) {
      setStatus(
        keptEdits
          ? `已压缩并还原 ${counter.restoredCount} 处嵌套字符串（已保留编辑）`
          : `已压缩并还原 ${counter.restoredCount} 处嵌套字符串，可安全写入`,
        'success'
      );
    } else {
      setStatus('已压缩 JSON', 'success');
    }
  } catch {
    setStatus('不是合法 JSON，无法压缩', 'error');
  }
}

/**
 * 行内复制值
 * @param {string} rowId
 */
async function handleRowCopy(rowId) {
  const textarea = getRowValueTextarea(rowId);
  if (!textarea) {
    return;
  }
  const text = textarea.value;
  if (!text) {
    setStatus('没有可复制的内容', 'empty');
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      if (!copied) {
        throw new Error('execCommand copy failed');
      }
    }
    setStatus('已复制到剪贴板', 'success');
  } catch {
    setStatus('复制失败，请手动选中复制', 'error');
  }
}

/**
 * 行内粘贴值
 * @param {string} rowId
 */
async function handleRowPaste(rowId) {
  const textarea = getRowValueTextarea(rowId);
  if (!textarea) {
    return;
  }
  ensureFormatBoundToRow(rowId);

  try {
    if (!navigator.clipboard?.readText) {
      throw new Error('clipboard API unavailable');
    }
    const text = await navigator.clipboard.readText();
    if (!text) {
      setStatus('剪贴板为空（或非文本内容）', 'empty');
      return;
    }
    textarea.value = text;
    syncRowModelFromDom(rowId);
    clearFormatStateForUi();
    setStatus(`已粘贴，长度 ${text.length}`, 'success');
    textarea.focus();
  } catch {
    setStatus(
      '粘贴失败：请重新加载扩展后再试，或直接在输入框按 Ctrl/Cmd + V',
      'error'
    );
    textarea.focus();
  }
}

/**
 * 读取目标 key 是否已存在（cookie 按 name 读取，可能命中同名其他 Path）
 * @param {chrome.tabs.Tab} tab
 * @param {string} key
 * @param {TableRowModel} row
 */
async function readExistingForSave(tab, key, row) {
  if (currentStorageType === STORAGE_TYPES.cookie) {
    // 精确 identity：同 path+domain 才算覆盖同一条
    const cookieOptions = getCookieWriteOptions();
    const all = await collectTabCookies(tab);
    const nextPath = cookieOptions.path || '/';
    const nextDomainNorm = (cookieOptions.domain || '').replace(/^\./, '');
    const sameIdentity = all.find((cookie) => {
      if (cookie.name !== key) {
        return false;
      }
      const oldPath = cookie.path || '/';
      const oldDomainNorm = cookie.hostOnly ? '' : String(cookie.domain || '').replace(/^\./, '');
      return oldPath === nextPath && oldDomainNorm === nextDomainNorm;
    });
    if (sameIdentity) {
      return { value: sameIdentity.value, httpOnly: Boolean(sameIdentity.httpOnly), cookie: sameIdentity };
    }
    // 草稿/改名新建：也提示同名其他 Path 会被 replace-all 清掉
    const sameName = all.filter((cookie) => cookie.name === key);
    if (sameName.length) {
      return {
        value: sameName[0].value,
        httpOnly: Boolean(sameName[0].httpOnly),
        cookie: sameName[0],
        sameNameConflict: true,
        sameNameCount: sameName.length,
      };
    }
    return { value: null, httpOnly: false, cookie: null };
  }
  return readStorageValue(tab, currentStorageType, key);
}

/**
 * 行内保存
 * @param {string} rowId
 */
async function handleRowSave(rowId) {
  if (isBusy) {
    return;
  }

  syncRowModelFromDom(rowId);
  const row = tableRows.find((item) => item.rowId === rowId);
  if (!row) {
    return;
  }

  const key = row.key.trim();
  if (!key) {
    setStatus('请输入 key', 'error');
    getRowKeyInput(rowId)?.focus();
    return;
  }

  const textarea = getRowValueTextarea(rowId);
  if (!textarea) {
    return;
  }

  if (!textarea.value) {
    setStatus('请先粘贴或输入要写入的值（空字符串拒绝写入）', 'error');
    textarea.focus();
    return;
  }

  ensureFormatBoundToRow(rowId);
  const prepared = prepareValueForWrite(textarea.value);
  const value = prepared.text;
  const keptEditsOnWrite = formatExpandDirty && prepared.restoredCount > 0;

  // 保存前先把压缩结果回写到单元格，与「编辑自动格式化」对称
  if (value !== textarea.value) {
    textarea.value = value;
    syncRowModelFromDom(rowId);
  }

  const isRename =
    !row.isDraft &&
    row.originKey != null &&
    row.originKey !== key &&
    currentStorageType !== STORAGE_TYPES.cookie;

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    if (isRename) {
      const oldKey = row.originKey;
      const oldData = await readStorageValue(tab, currentStorageType, oldKey);
      const newData = await readStorageValue(tab, currentStorageType, key);
      let body = `将把「${oldKey}」重命名为「${key}」（删除旧 key 并写入新 key）。\n\n新值（${value.length} 字符）：\n${truncateText(value)}`;
      if (oldData.value !== null) {
        body += `\n\n旧 key 当前值（${oldData.value.length} 字符）：\n${truncateText(oldData.value)}`;
      }
      if (newData.value !== null) {
        body += `\n\n警告：目标 key「${key}」已存在（${newData.value.length} 字符），将被覆盖：\n${truncateText(newData.value)}`;
      }
      const confirmed = await showConfirmDialog({
        title: `确认重命名「${oldKey}」→「${key}」？`,
        body,
        okText: '确认重命名',
        danger: true,
      });
      if (!confirmed) {
        setStatus('已取消保存', 'empty');
        return;
      }
    } else {
      const existingData = await readExistingForSave(tab, key, row);
      const cookieOptionsPreview =
        currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : null;
      const cookieAttrLines = [];
      if (cookieOptionsPreview && existingData.cookie) {
        const oldCookie = existingData.cookie;
        const flag = (yes) => (yes ? '是' : '否');
        if (Boolean(oldCookie.httpOnly) !== Boolean(cookieOptionsPreview.httpOnly)) {
          cookieAttrLines.push(
            `HttpOnly：${flag(oldCookie.httpOnly)} → ${flag(cookieOptionsPreview.httpOnly)}`
          );
        }
        if (Boolean(oldCookie.secure) !== Boolean(cookieOptionsPreview.secure)) {
          cookieAttrLines.push(
            `Secure：${flag(oldCookie.secure)} → ${flag(cookieOptionsPreview.secure)}`
          );
        }
        const oldPath = oldCookie.path || '/';
        if (oldPath !== (cookieOptionsPreview.path || '/')) {
          cookieAttrLines.push(`Path：${oldPath} → ${cookieOptionsPreview.path || '/'}`);
        }
        const oldDomain = oldCookie.hostOnly ? '' : oldCookie.domain || '';
        if (oldDomain.replace(/^\./, '') !== (cookieOptionsPreview.domain || '').replace(/^\./, '')) {
          cookieAttrLines.push(
            `Domain：${oldDomain || '(host-only)'} → ${cookieOptionsPreview.domain || '(host-only)'}`
          );
        }
        const oldSameSite = mapSameSiteFromApi(oldCookie.sameSite);
        if (oldSameSite !== (cookieOptionsPreview.sameSite || '')) {
          cookieAttrLines.push(
            `SameSite：${oldSameSite || '默认'} → ${cookieOptionsPreview.sameSite || '默认'}`
          );
        }
      }

      if (existingData.value !== null && existingData.value !== value) {
        let body = `旧值（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}\n\n新值（${value.length} 字符）：\n${truncateText(value)}`;
        if (cookieAttrLines.length) {
          body += `\n\n属性变更：\n- ${cookieAttrLines.join('\n- ')}`;
        }
        if (existingData.sameNameConflict) {
          body += `\n\n注意：存在 ${existingData.sameNameCount} 条同名 cookie（不同 Path/Domain），写入将按「同名全部替换」策略清理后写入当前属性。`;
        }
        const confirmed = await showConfirmDialog({
          title: `确认覆盖写入「${key}」？`,
          body,
          okText: '确认覆盖',
          danger: true,
        });
        if (!confirmed) {
          setStatus('已取消保存', 'empty');
          return;
        }
      } else if (existingData.value === null) {
        let body = `将写入新值（${value.length} 字符）：\n${truncateText(value)}`;
        if (cookieOptionsPreview) {
          body += `\n\n属性：HttpOnly=${cookieOptionsPreview.httpOnly ? '是' : '否'}，Secure=${cookieOptionsPreview.secure ? '是' : '否'}，Path=${cookieOptionsPreview.path || '/'}`;
        }
        const confirmed = await showConfirmDialog({
          title: `确认新建写入「${key}」？`,
          body,
          okText: '确认写入',
        });
        if (!confirmed) {
          setStatus('已取消保存', 'empty');
          return;
        }
      } else if (cookieAttrLines.length) {
        // 值未变，仅改 Cookie 属性（如勾选/取消 HttpOnly）
        const confirmed = await showConfirmDialog({
          title: `确认更新「${key}」的 Cookie 属性？`,
          body: `值未变化，将更新属性：\n- ${cookieAttrLines.join('\n- ')}\n\n提示：徽章只反映已写入的结果，改勾选后需点「保存」才会生效。`,
          okText: '确认更新属性',
          danger: true,
        });
        if (!confirmed) {
          setStatus('已取消保存', 'empty');
          return;
        }
      }
    }

    setBusy(true);
    if (prepared.usedFallback) {
      setStatus('已回退格式化前原文并压缩，写入中...');
    } else if (keptEditsOnWrite) {
      setStatus(`已按编辑重序列化 ${prepared.restoredCount} 处并压缩，写入中...`);
    } else if (prepared.restoredCount > 0) {
      setStatus(`已还原 ${prepared.restoredCount} 处并压缩，写入中...`);
    } else if (prepared.minified) {
      setStatus('已压缩，写入中...');
    } else {
      setStatus('写入中...');
    }

    const cookieOptions =
      currentStorageType === STORAGE_TYPES.cookie ? getCookieWriteOptions() : undefined;

    if (isRename && row.originKey) {
      const deleteResult = await deleteStorageValue(tab, currentStorageType, row.originKey);
      if (!deleteResult.success) {
        setStatus(`重命名失败：旧 key「${row.originKey}」删除未成功`, 'error');
        return;
      }
    }

    const pageData = await writeStorageValue(
      tab,
      currentStorageType,
      key,
      value,
      cookieOptions
    );

    clearFormatStateForUi();
    textarea.value = pageData.value ?? value;
    syncRowModelFromDom(rowId);
    await pushKeyHistory(key);

    if (!pageData.success) {
      let failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '写入后回读不一致（可能被浏览器拒绝：Secure/SameSite/Domain/大小限制等）'
          : '写入后回读不一致，请确认页面是否允许写入';
      if (pageData.error) {
        failTip = pageData.error;
      }
      if (pageData.attributeMismatch) {
        failTip = `${pageData.error || 'Cookie 属性未按预期生效'}。请确认已选中对应行后再保存；若页面脚本会重写该 cookie，刷新后可能被覆盖。`;
      }
      if (pageData.prefixTip) {
        failTip += `（${pageData.prefixTip}）`;
      }
      setStatus(failTip, 'error');
      await refreshAndRenderTable({
        preferActiveKey:
          currentStorageType === STORAGE_TYPES.cookie && pageData.cookie
            ? buildCookieCacheKey(pageData.cookie)
            : key,
      });
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
    } else if (keptEditsOnWrite) {
      prepareTip = `，已保留编辑并还原 ${prepared.restoredCount} 处嵌套字符串`;
    } else if (prepared.restoredCount > 0) {
      prepareTip = `，已还原 ${prepared.restoredCount} 处嵌套字符串`;
    } else if (prepared.minified) {
      prepareTip = '，已压缩';
    }

    setStatus(
      `写入成功：${getStorageTypeLabel(currentStorageType)} / ${key}（长度 ${value.length}）${cookieTip}${prepareTip}`,
      'success'
    );

    await refreshAndRenderTable({
      preferActiveKey:
        currentStorageType === STORAGE_TYPES.cookie && pageData.cookie
          ? buildCookieCacheKey(pageData.cookie)
          : key,
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '写入失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 行内删除
 * @param {string} rowId
 */
async function handleRowDelete(rowId) {
  if (isBusy) {
    return;
  }

  syncRowModelFromDom(rowId);
  const row = tableRows.find((item) => item.rowId === rowId);
  if (!row) {
    return;
  }

  // 草稿未入库：直接移除
  if (row.isDraft) {
    tableRows = tableRows.filter((item) => item.rowId !== rowId);
    if (formatBoundRowId === rowId) {
      clearFormatStateForUi();
    }
    if (activeRowId === rowId) {
      activeRowId = tableRows[0]?.rowId || null;
    }
    renderStorageTable();
    if (activeRowId) {
      setActiveRow(activeRowId);
    }
    setStatus('已移除草稿行', 'success');
    return;
  }

  const key = (row.originKey || row.key || '').trim();
  if (!key) {
    setStatus('无法删除：缺少 key', 'error');
    return;
  }

  const typeLabel = getStorageTypeLabel(currentStorageType);

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    let existingValue = row.value;
    let httpOnly = false;
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const cookie = getCookieDetailForRow(row);
      httpOnly = Boolean(cookie?.httpOnly);
      existingValue = cookie?.value ?? row.value;
    } else {
      const existingData = await readStorageValue(tab, currentStorageType, key);
      if (existingData.value !== null) {
        existingValue = existingData.value;
      }
    }

    let body =
      existingValue === '' || existingValue == null
        ? `当前读不到「${key}」的值（可能不存在）。仍尝试删除？`
        : `将删除「${key}」当前值（${String(existingValue).length} 字符）：\n${truncateText(String(existingValue))}`;

    if (httpOnly) {
      body += '\n\n该 cookie 为 HttpOnly，将通过 chrome.cookies API 删除。';
    }

    let cookieOptions;
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const cookie = getCookieDetailForRow(row);
      // 删除前把该行属性同步到栏，保证 Path/Domain 精确匹配
      if (cookie) {
        applyCookieDetailsToForm(cookie);
      }
      const writeOptions = getCookieWriteOptions();
      cookieOptions = { path: writeOptions.path, domain: writeOptions.domain };
      body += `\n\n将按 Path=${cookieOptions.path}${cookieOptions.domain ? ` Domain=${cookieOptions.domain}` : '（host-only）'} 精确删除。`;
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

    const pageData = await deleteStorageValue(tab, currentStorageType, key, cookieOptions);

    if (!pageData.success) {
      const failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '删除失败：未删掉匹配的 cookie。请确认上方 Path/Domain（同名多 Path 时需精确匹配）'
          : '删除失败：key 仍存在';
      setStatus(failTip, 'error');
      return;
    }

    if (formatBoundRowId === rowId) {
      clearFormatStateForUi();
    }
    await pushKeyHistory(key);
    setStatus(`已删除：${typeLabel} / ${key}`, 'success');
    await refreshAndRenderTable();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '删除失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 导出当前类型全部条目（JSON v2）
 */
async function handleExport() {
  if (isBusy) {
    return;
  }

  setBusy(true);
  setStatus('导出中...');

  try {
    const pageData = await refreshAndRenderTable();
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

    await refreshAndRenderTable();

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
 * 切换存储类型
 * @param {string} storageType
 */
async function switchStorageType(storageType) {
  if (!Object.values(STORAGE_TYPES).includes(storageType) || storageType === currentStorageType || isBusy) {
    return;
  }

  currentStorageType = storageType;
  renderActiveTab();
  pageKeyCache = [];
  pageEntriesCache = {};
  cookieDetailCache = {};
  clearCookiePreservedExpiration();
  cookieMaxAgeInput.value = '';
  clearFormatStateForUi();
  tableRows = [];
  activeRowId = null;

  await chrome.storage.local.set({ [LAST_TYPE_STORAGE]: storageType });

  setBusy(true);
  setStatus('切换中...');
  try {
    const pageData = await refreshAndRenderTable();
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const httpOnlyCount = Object.values(cookieDetailCache).filter((item) => item.httpOnly).length;
      setStatus(
        `共 ${pageKeyCache.length} 个 cookie（HttpOnly ${httpOnlyCount}）`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    } else {
      setStatus(
        `共 ${pageKeyCache.length} 个 key`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    }
    void pageData;
  } catch (error) {
    tableRows = [];
    renderStorageTable();
    setStatus(error instanceof Error ? error.message : '切换失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 刷新按钮
 */
async function handleRefresh() {
  if (isBusy) {
    return;
  }
  setBusy(true);
  setStatus('刷新中...');
  try {
    await refreshAndRenderTable({ keepDrafts: true });
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const httpOnlyCount = Object.values(cookieDetailCache).filter((item) => item.httpOnly).length;
      setStatus(
        `共 ${pageKeyCache.length} 个 cookie（HttpOnly ${httpOnlyCount}）`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    } else {
      setStatus(
        `共 ${pageKeyCache.length} 个 key`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '刷新失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 一键清空当前类型的全部存储
 */
async function handleClearAll() {
  if (isBusy) {
    return;
  }

  const typeLabel = getStorageTypeLabel(currentStorageType);
  let count = pageKeyCache.length;
  try {
    // 确认前尽量刷新一次，避免数量过期
    await refreshAndRenderTable({ keepDrafts: false });
    count = pageKeyCache.length;
  } catch {
    // 刷新失败仍允许按当前缓存确认
  }

  if (!count) {
    setStatus(`当前 ${typeLabel} 已为空`, 'empty');
    return;
  }

  const previewKeys = pageKeyCache.slice(0, 8).map((key) => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const detail = cookieDetailCache[key];
      const name = detail?.name || key;
      const path = detail?.path || '/';
      return `- ${name} (path=${path})`;
    }
    return `- ${key}`;
  });
  const moreTip = count > 8 ? `\n…共 ${count} 条` : '';
  const cookieTip =
    currentStorageType === STORAGE_TYPES.cookie
      ? '\n\n将按每条 Cookie 的 Path/Domain 精确删除（含 HttpOnly）。'
      : '\n\n将调用 clear() 清空当前源下全部条目。';

  const confirmed = await showConfirmDialog({
    title: `确认清空全部 ${typeLabel}？`,
    body: `此操作不可恢复，将删除：\n${previewKeys.join('\n')}${moreTip}${cookieTip}`,
    okText: '确认清空',
    danger: true,
  });
  if (!confirmed) {
    setStatus('已取消清空', 'empty');
    return;
  }

  setBusy(true);
  setStatus('清空中...');
  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    if (currentStorageType === STORAGE_TYPES.cookie) {
      const result = await clearAllCookiesViaApi(tab);
      clearFormatStateForUi();
      await refreshAndRenderTable();
      if (result.failCount > 0) {
        setStatus(
          `清空完成：成功 ${result.successCount}，失败 ${result.failCount}`,
          'error'
        );
      } else {
        setStatus(`已清空全部 cookie（${result.successCount} 条）`, 'success');
      }
      return;
    }

    const result = await executeInTab(tab.id, clearPageStorage, [currentStorageType]);
    clearFormatStateForUi();
    await refreshAndRenderTable();
    if (!result.success) {
      setStatus(
        `清空未完成：仍剩余 ${result.remainCount ?? '?'} 条`,
        'error'
      );
      return;
    }
    setStatus(`已清空全部 ${typeLabel}（${result.clearedCount ?? count} 条）`, 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '清空失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * tbody 事件委托：行操作
 * @param {MouseEvent} event
 */
function handleTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const tr = target.closest('tr[data-row-id]');
  if (!(tr instanceof HTMLTableRowElement) || !tr.dataset.rowId) {
    return;
  }
  const rowId = tr.dataset.rowId;

  // 点击行设为 active
  if (rowId !== activeRowId) {
    setActiveRow(rowId);
  }

  const actionBtn = target.closest('[data-action]');
  if (!(actionBtn instanceof HTMLElement) || !actionBtn.dataset.action) {
    return;
  }

  const action = actionBtn.dataset.action;
  if (action === 'edit-json') {
    openJsonDialog(rowId, 'edit');
  } else if (action === 'copy') {
    handleRowCopy(rowId);
  } else if (action === 'paste') {
    handleRowPaste(rowId);
  } else if (action === 'save') {
    handleRowSave(rowId);
  } else if (action === 'delete') {
    handleRowDelete(rowId);
  }
}

/**
 * 行内 focus 时设为 active
 * @param {FocusEvent} event
 */
function handleTableFocusIn(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const tr = target.closest('tr[data-row-id]');
  if (!(tr instanceof HTMLTableRowElement) || !tr.dataset.rowId) {
    return;
  }
  if (tr.dataset.rowId !== activeRowId) {
    setActiveRow(tr.dataset.rowId);
  }
}

/**
 * 行内输入：同步模型；格式化展开后标记 dirty
 * @param {Event} event
 */
function handleTableInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const tr = target.closest('tr[data-row-id]');
  if (!(tr instanceof HTMLTableRowElement) || !tr.dataset.rowId) {
    return;
  }
  const rowId = tr.dataset.rowId;
  syncRowModelFromDom(rowId);

  if (target.classList.contains('row-value')) {
    if (formatBoundRowId === rowId && formatExpandActive) {
      formatExpandDirty = true;
    } else if (formatBoundRowId && formatBoundRowId !== rowId) {
      // 编辑其他行值：解绑旧格式化态
      clearFormatStateForUi();
    }
  }
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
 * 初始化弹窗：恢复 last storage type → 刷新并渲染表格
 */
async function initPopup() {
  applyPopupMaxHeight();

  const stored = await chrome.storage.local.get([LAST_TYPE_STORAGE]);
  const savedType = stored[LAST_TYPE_STORAGE];
  currentStorageType = Object.values(STORAGE_TYPES).includes(savedType)
    ? savedType
    : DEFAULT_STORAGE_TYPE;
  renderActiveTab();

  storageTypeTabsEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const storageType = target.closest('.tab-item')?.dataset?.type || target.dataset.type;
    if (!storageType) {
      return;
    }
    switchStorageType(storageType);
  });
  storageTypeTabsEl.addEventListener('keydown', handleTablistKeydown);

  refreshKeysBtn.addEventListener('click', handleRefresh);
  keysFilterInput.addEventListener('input', () => {
    filterKeyword = keysFilterInput.value;
    // 筛选前把可见行 DOM 值写回，避免丢编辑
    tableRows.forEach((row) => syncRowModelFromDom(row.rowId));
    renderStorageTable();
    if (activeRowId) {
      setActiveRow(activeRowId, { syncCookie: false });
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
  viewAllJsonBtn.addEventListener('click', () => openAllJsonDialog('view'));
  editAllJsonBtn.addEventListener('click', () => openAllJsonDialog('edit'));
  clearAllBtn.addEventListener('click', handleClearAll);

  addRowBtn.addEventListener('click', handleAddRow);

  jsonFormatBtn.addEventListener('click', handleJsonDialogFormat);
  jsonCompressBtn.addEventListener('click', handleJsonDialogCompress);
  jsonCopyBtn.addEventListener('click', handleJsonDialogCopy);
  jsonPasteBtn.addEventListener('click', (event) => {
    event.preventDefault();
    handleJsonDialogPaste();
  });
  jsonClearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    handleJsonDialogClear();
  });
  jsonSaveBtn.addEventListener('click', (event) => {
    event.preventDefault();
    handleJsonDialogSave();
  });
  jsonDeleteBtn.addEventListener('click', (event) => {
    event.preventDefault();
    handleJsonDialogDelete();
  });
  jsonDialog.addEventListener('close', () => {
    jsonDialogRowId = null;
    jsonDialogMode = 'view';
    jsonDialogScope = 'row';
  });
  jsonDialogEditor.addEventListener('input', () => {
    if (jsonDialogMode !== 'edit') {
      return;
    }
    const formatTargetId = getJsonDialogFormatTargetId();
    if (formatBoundRowId && formatTargetId && formatBoundRowId === formatTargetId && formatExpandActive) {
      formatExpandDirty = true;
    }
    let isJson = false;
    try {
      JSON.parse(jsonDialogEditor.value.trim());
      isJson = true;
    } catch {
      isJson = false;
    }
    updateJsonDialogMeta(jsonDialogEditor.value, isJson);
  });

  storageTableBody.addEventListener('click', handleTableClick);
  storageTableBody.addEventListener('focusin', handleTableFocusIn);
  storageTableBody.addEventListener('input', handleTableInput);
  storageTableBody.addEventListener('paste', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('row-value')) {
      return;
    }
    const tr = target.closest('tr[data-row-id]');
    if (!(tr instanceof HTMLTableRowElement) || !tr.dataset.rowId) {
      return;
    }
    const rowId = tr.dataset.rowId;
    // 全选粘贴视为换新内容，清掉展开态
    const allSelected =
      target.selectionStart === 0 && target.selectionEnd === target.value.length;
    if (formatBoundRowId === rowId && formatExpandActive && (allSelected || !target.value)) {
      clearFormatStateForUi();
    }
  });

  cookieSameSiteSelect.addEventListener('change', () => {
    if (cookieSameSiteSelect.value === 'None') {
      cookieSecureCheckbox.checked = true;
    }
    if (currentStorageType === STORAGE_TYPES.cookie) {
      setStatus('Cookie 属性已修改，请点击对应行的「保存」写入', 'empty');
    }
  });
  cookieSecureCheckbox.addEventListener('change', () => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      setStatus('Cookie 属性已修改，请点击对应行的「保存」写入', 'empty');
    }
  });
  cookieHttpOnlyCheckbox.addEventListener('change', () => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      setStatus(
        cookieHttpOnlyCheckbox.checked
          ? '已勾选 HttpOnly，请点击对应行的「保存」写入（徽章保存后才会变）'
          : '已取消 HttpOnly，请点击对应行的「保存」写入（徽章保存后才会变）',
        'empty'
      );
    }
  });
  cookiePathInput.addEventListener('change', () => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      setStatus('Cookie 属性已修改，请点击对应行的「保存」写入', 'empty');
    }
  });
  cookieDomainInput.addEventListener('change', () => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      setStatus('Cookie 属性已修改，请点击对应行的「保存」写入', 'empty');
    }
  });
  cookieMaxAgeInput.addEventListener('change', () => {
    if (currentStorageType === STORAGE_TYPES.cookie) {
      setStatus('Cookie 属性已修改，请点击对应行的「保存」写入', 'empty');
    }
  });

  setBusy(true);
  setStatus('加载中...');
  try {
    await refreshAndRenderTable();
    if (currentStorageType === STORAGE_TYPES.cookie) {
      const httpOnlyCount = Object.values(cookieDetailCache).filter((item) => item.httpOnly).length;
      setStatus(
        `共 ${pageKeyCache.length} 个 cookie（HttpOnly ${httpOnlyCount}）`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    } else {
      setStatus(
        `共 ${pageKeyCache.length} 个 key`,
        pageKeyCache.length ? 'success' : 'empty'
      );
    }
  } catch (error) {
    tableRows = [];
    renderStorageTable();
    setStatus(error instanceof Error ? error.message : '加载失败', 'error');
  } finally {
    setBusy(false);
  }
}

initPopup();

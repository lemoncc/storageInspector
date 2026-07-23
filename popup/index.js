const STORAGE_TYPES = {
  localStorage: 'localStorage',
  sessionStorage: 'sessionStorage',
  cookie: 'cookie',
};

const DEFAULT_STORAGE_TYPE = STORAGE_TYPES.localStorage;
const LAST_TYPE_STORAGE = 'last-storage-type';
const HISTORY_LIMIT = 10;
/** 筛选关键字历史条数上限 */
const FILTER_HISTORY_LIMIT = 5;
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
const keysFilterClearBtn = document.getElementById('keysFilterClearBtn');
const keysFilterDropdown = document.getElementById('keysFilterDropdown');
const keysFilterWrap = keysFilterInput?.closest('.keys-filter-wrap') || null;
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
const cookieMakeSessionBtn = document.getElementById('cookieMakeSessionBtn');
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
const jsonDialogToastEl = document.getElementById('jsonDialogToast');
const jsonFormatBtn = document.getElementById('jsonFormatBtn');
const jsonCompressBtn = document.getElementById('jsonCompressBtn');
const jsonCopyBtn = document.getElementById('jsonCopyBtn');
const jsonPasteBtn = document.getElementById('jsonPasteBtn');
const jsonClearBtn = document.getElementById('jsonClearBtn');
const jsonSaveBtn = document.getElementById('jsonSaveBtn');
const jsonDeleteBtn = document.getElementById('jsonDeleteBtn');
const jsonCloseBtn = document.getElementById('jsonCloseBtn');

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
/** 当前类型的筛选历史（内存缓存，最近在前） */
let filterHistoryCache = [];
/** 筛选 input 序号，丢弃过期的异步回调 */
let filterInputSeq = 0;
/** 筛选下拉是否展开 */
let filterDropdownOpen = false;
/** 筛选下拉当前高亮项索引（-1 表示无） */
let filterDropdownActiveIndex = -1;
/** 筛选下拉当前可选项（扁平，用于键盘导航） */
let filterDropdownFlatOptions = [];
/** 失焦关闭下拉的延时句柄 */
let filterDropdownBlurTimer = 0;
/** JSON 弹窗内提示自动隐藏句柄 */
let jsonDialogToastTimer = 0;
/** 打开 JSON 弹窗时的编辑器基线，用于判断点遮罩是否丢弃未保存修改 */
let jsonDialogBaselineText = '';

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
 * 获取某存储类型筛选关键字历史的缓存字段
 * @param {string} storageType
 * @returns {string}
 */
function getFilterHistoryField(storageType) {
  return `filter-history:${storageType}`;
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
    parsedUrl.hostname === 'chromewebstore.google.com' ||
    (parsedUrl.hostname === 'chrome.google.com' && parsedUrl.pathname.startsWith('/webstore'));
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
  if (sameSite === 'Lax' || sameSite === 'lax') {
    return 'lax';
  }
  if (sameSite === 'Strict' || sameSite === 'strict') {
    return 'strict';
  }
  if (sameSite === 'None' || sameSite === 'no_restriction') {
    return 'no_restriction';
  }
  if (sameSite === 'unspecified') {
    return 'unspecified';
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
  // unspecified 在表单无对应项，显示为「默认」；cookies[] 导入另路保留
  return '';
}

/**
 * 序列化 partitionKey，用于 cache / 合并去重
 * @param {chrome.cookies.CookiePartitionKey | null | undefined} partitionKey
 * @returns {string}
 */
function serializePartitionKeyPart(partitionKey) {
  if (!partitionKey || typeof partitionKey !== 'object') {
    return '';
  }
  const topLevelSite =
    typeof partitionKey.topLevelSite === 'string' ? partitionKey.topLevelSite : '';
  const hasCrossSiteAncestor = partitionKey.hasCrossSiteAncestor ? '1' : '0';
  return `${topLevelSite}\u0002${hasCrossSiteAncestor}`;
}

/**
 * 生成 cookie 缓存键（同名不同 Path/Domain/partition 互不覆盖）
 * @param {{ name?: string, path?: string, domain?: string, hostOnly?: boolean, partitionKey?: chrome.cookies.CookiePartitionKey }} cookie
 * @returns {string}
 */
function buildCookieCacheKey(cookie) {
  const name = cookie.name || '';
  const path = cookie.path || '/';
  const domainPart = cookie.hostOnly
    ? ''
    : String(cookie.domain || '').replace(/^\./, '');
  const partitionPart = serializePartitionKeyPart(cookie.partitionKey);
  return `${name}\u0001${path}\u0001${domainPart}\u0001${partitionPart}`;
}

/**
 * 判断 cookie 是否与目标 Path/Domain/partition 为同一 identity
 * @param {chrome.cookies.Cookie} cookie
 * @param {string} nextPath
 * @param {string} nextDomainNorm
 * @param {string} [nextPartitionSig]
 * @returns {boolean}
 */
function isCookieSameIdentity(cookie, nextPath, nextDomainNorm, nextPartitionSig = '') {
  const oldPath = cookie.path || '/';
  const oldDomainNorm = cookie.hostOnly ? '' : String(cookie.domain || '').replace(/^\./, '');
  if (oldPath !== nextPath || oldDomainNorm !== nextDomainNorm) {
    return false;
  }
  // 分区签名需一致：无分区只匹配无分区条目，避免误伤 CHIPS Cookie
  return serializePartitionKeyPart(cookie.partitionKey) === nextPartitionSig;
}

/**
 * 导出用 cookie 序列化
 * @param {chrome.cookies.Cookie} cookie
 * @returns {Record<string, any>}
 */
function serializeCookieForExport(cookie) {
  /** @type {Record<string, any>} */
  const payload = {
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
  if (cookie.partitionKey && typeof cookie.partitionKey === 'object') {
    payload.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite || '',
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  return payload;
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
  // 兼容 API 小写、表单大写；unspecified 原样保留以便 set 时写回
  let sameSite = sameSiteRaw;
  if (sameSiteRaw === 'unspecified') {
    sameSite = 'unspecified';
  } else if (
    sameSiteRaw === 'lax' ||
    sameSiteRaw === 'strict' ||
    sameSiteRaw === 'no_restriction'
  ) {
    sameSite = mapSameSiteFromApi(sameSiteRaw);
  }
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
    partitionKey:
      item.partitionKey && typeof item.partitionKey === 'object'
        ? {
            topLevelSite:
              typeof item.partitionKey.topLevelSite === 'string'
                ? item.partitionKey.topLevelSite
                : '',
            hasCrossSiteAncestor: Boolean(item.partitionKey.hasCrossSiteAncestor),
          }
        : undefined,
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
 * @param {{ applySideEffects?: boolean }} [enforceOptions]
 * @returns {{ path: string, maxAge: number | null, domain: string, secure: boolean, sameSite: string, httpOnly: boolean, expirationDate?: number | null, prefixTip: string }}
 */
function enforceCookieNamePrefixRules(key, options, enforceOptions = {}) {
  const { applySideEffects = true } = enforceOptions;
  const next = { ...options, prefixTip: '' };
  if (key.startsWith('__Host-')) {
    // RFC：必须 Secure、Path=/、且不能带 Domain
    next.secure = true;
    next.path = '/';
    next.domain = '';
    next.prefixTip = '__Host- 前缀已强制 Secure、Path=/、无 Domain';
    if (applySideEffects) {
      cookieSecureCheckbox.checked = true;
      cookiePathInput.value = '/';
      cookieDomainInput.value = '';
    }
  } else if (key.startsWith('__Secure-')) {
    next.secure = true;
    next.prefixTip = '__Secure- 前缀已强制 Secure';
    if (applySideEffects) {
      cookieSecureCheckbox.checked = true;
    }
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
 * getAll 包装：优先带 partitionKey:{} 拉全部分区；旧环境回退
 * @param {chrome.cookies.GetAllDetails} details
 * @returns {Promise<chrome.cookies.Cookie[]>}
 */
async function cookiesGetAllWithPartition(details) {
  try {
    return await chrome.cookies.getAll({ ...details, partitionKey: {} });
  } catch {
    return await chrome.cookies.getAll(details);
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
      const mapKey = buildCookieCacheKey(cookie);
      if (!merged.has(mapKey)) {
        merged.set(mapKey, cookie);
      }
    });
  };

  // 1. 拉取 store 内全部 cookie（含分区罐），再按主机过滤
  // 说明：仅用当前 url 查询时，Path 更具体的子路由 cookie（且 host-only）会被漏掉；
  // domain 查询又拿不到 host-only cookie，所以这里以全量 + 主机过滤为主。
  // partitionKey: {} 会同时返回未分区与 CHIPS 分区 Cookie（Chrome 119+）
  const allInStore = await cookiesGetAllWithPartition({
    ...(storeId ? { storeId } : {}),
  });
  mergeCookies(allInStore);

  // 2. 按路径前缀逐级查询，覆盖子路由 Path（同样打开分区罐）
  for (const prefix of pathPrefixes) {
    const prefixUrl = `${origin}${prefix}`;
    const byPrefix = await cookiesGetAllWithPartition({
      url: prefixUrl,
      ...(storeId ? { storeId } : {}),
    });
    mergeCookies(byPrefix);
  }

  // 3. domain 再补一轮（带 Domain 属性的跨子域 cookie）
  for (const domain of domainCandidates) {
    const byDomain = await cookiesGetAllWithPartition({
      domain,
      ...(storeId ? { storeId } : {}),
    });
    mergeCookies(byDomain);
  }

  // 4. storeId 异常时兜底
  if (!merged.size) {
    mergeCookies(await cookiesGetAllWithPartition({}));
    for (const prefix of pathPrefixes) {
      mergeCookies(
        await cookiesGetAllWithPartition({
          url: `${origin}${prefix}`,
        })
      );
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
async function writeCookieViaApi(tab, key, value, options, conflictMode = 'upsert-identity') {
  const routeInfo = buildRouteInfoFromTab(tab);
  await ensureCookieHostPermission(tab.url || '');
  const storeId = tab.id ? await getTabCookieStoreId(tab.id) : undefined;

  const applyFormSideEffects = options?.applySideEffects !== false;
  const normalizedOptions = enforceCookieNamePrefixRules(key, options, {
    applySideEffects: applyFormSideEffects,
  });
  let sameSite = mapSameSiteToApi(normalizedOptions.sameSite);
  let secure = Boolean(normalizedOptions.secure);
  const httpOnly = Boolean(normalizedOptions.httpOnly);

  if (sameSite === 'no_restriction') {
    secure = true;
    if (applyFormSideEffects) {
      cookieSecureCheckbox.checked = true;
    }
  }

  const nextPath = normalizedOptions.path || '/';
  const nextDomainNorm = (normalizedOptions.domain || '').replace(/^\./, '');
  const nextPartitionSig = serializePartitionKeyPart(normalizedOptions.partitionKey);

  // 先定位同 identity / 待删项；同 identity 不先 remove（set 即可覆盖），避免 set 失败丢数据
  const existingCookies = (await collectTabCookies(tab)).filter((cookie) => cookie.name === key);
  /** @type {chrome.cookies.Cookie | null} */
  let sameIdentityCookie = null;
  /** @type {chrome.cookies.Cookie[]} */
  const cookiesToRemoveAfterSet = [];
  for (const cookie of existingCookies) {
    const isSameIdentity = isCookieSameIdentity(
      cookie,
      nextPath,
      nextDomainNorm,
      nextPartitionSig
    );
    if (isSameIdentity) {
      sameIdentityCookie = cookie;
      continue;
    }
    if (conflictMode === 'replace-all-same-name') {
      cookiesToRemoveAfterSet.push(cookie);
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
    ...buildPartitionKeyField(sameIdentityCookie || { partitionKey: normalizedOptions.partitionKey }),
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

  // set 成功后再清理其它同名（仅 replace-all 模式）
  for (const cookie of cookiesToRemoveAfterSet) {
    await chrome.cookies.remove({
      url: buildCookieUrl(cookie, tab),
      name: key,
      storeId: cookie.storeId,
      ...buildPartitionKeyField(cookie),
    });
  }

  const actualHttpOnly = Boolean(result.httpOnly);
  const actualSecure = Boolean(result.secure);
  const attributeMismatch = actualHttpOnly !== httpOnly || actualSecure !== secure;

  cookieDetailCache[buildCookieCacheKey(result)] = result;
  if (applyFormSideEffects) {
    applyCookieDetailsToForm(result);
  }

  // set 已返回 Cookie 即视为写入成功；属性/值差异只作提示，不走失败分支
  const valueMismatched = result.value !== value;
  return {
    ...routeInfo,
    value: result.value,
    success: true,
    valueMismatched,
    attributeMismatch,
    expectedHttpOnly: httpOnly,
    actualHttpOnly,
    expectedSecure: secure,
    actualSecure,
    httpOnly: actualHttpOnly,
    cookie: result,
    prefixTip: normalizedOptions.prefixTip,
    error: attributeMismatch
      ? `属性未按预期生效：HttpOnly 期望 ${httpOnly} / 实际 ${actualHttpOnly}，Secure 期望 ${secure} / 实际 ${actualSecure}`
      : undefined,
  };
}

/**
 * 按表单 Path/Domain/partition 筛选待删 cookie（同名多 Path 时只删当前目标）
 * @param {chrome.cookies.Cookie[]} cookies
 * @param {{ path?: string, domain?: string, partitionKey?: chrome.cookies.CookiePartitionKey }} options
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

  /** @type {chrome.cookies.Cookie[]} */
  let matched;
  if (optDomainNorm) {
    matched = samePath.filter((cookie) => {
      const cookieDomainNorm = cookie.hostOnly
        ? ''
        : String(cookie.domain || '').replace(/^\./, '');
      return cookieDomainNorm === optDomainNorm;
    });
  } else {
    // Domain 为空：仅匹配 host-only（与表单空 Domain 语义一致，避免误删同 Path 域名 Cookie）
    matched = samePath.filter((cookie) => cookie.hostOnly);
  }

  // 显式传入 partitionKey（含 undefined）时按分区精确过滤
  if (Object.prototype.hasOwnProperty.call(options, 'partitionKey')) {
    const nextPartitionSig = serializePartitionKeyPart(options.partitionKey);
    matched = matched.filter(
      (cookie) => serializePartitionKeyPart(cookie.partitionKey) === nextPartitionSig
    );
  }

  return matched;
}

/**
 * 通过 chrome.cookies 删除 cookie（含 HttpOnly）
 * @param {chrome.tabs.Tab} tab
 * @param {string} key
 * @param {{ path?: string, domain?: string, partitionKey?: chrome.cookies.CookiePartitionKey }} [options]
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
    const partitionField = buildPartitionKeyField({
      partitionKey: options.partitionKey,
    });
    try {
      const parsed = new URL(tab.url || '');
      const domain = (options.domain || parsed.hostname).replace(/^\./, '');
      for (const protocol of ['https:', 'http:']) {
        await chrome.cookies.remove({
          url: `${protocol}//${domain}${path}`,
          name: key,
          ...(storeId ? { storeId } : {}),
          ...partitionField,
        });
      }
    } catch {
      await chrome.cookies.remove({
        url: normalizeCookieQueryUrl(tab.url || ''),
        name: key,
        ...(storeId ? { storeId } : {}),
        ...partitionField,
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

  // 直接用 API 列表，确保带 storeId / partitionKey
  const cookies = await collectTabCookies(tab);

  for (const cookie of cookies) {
    if (!cookie?.name) {
      continue;
    }
    try {
      await chrome.cookies.remove({
        url: buildCookieUrl(cookie, tab),
        name: cookie.name,
        storeId: cookie.storeId,
        ...buildPartitionKeyField(cookie),
      });
    } catch {
      // 回读时统计残留
    }
  }

  const remain = await collectTabCookies(tab);
  const successCount = Math.max(0, cookies.length - remain.length);
  const failCount = remain.length;

  return {
    ...routeInfo,
    successCount,
    failCount,
    total: cookies.length,
    success: remain.length === 0,
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
      const result = await writeCookieViaApi(tab, key, value, {
        ...options,
        applySideEffects: false,
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
          partitionKey: item.partitionKey,
          applySideEffects: false,
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
 * @param {'replace-all-same-name' | 'upsert-identity'} [cookieConflictMode]
 */
async function writeStorageValue(
  tab,
  storageType,
  key,
  value,
  cookieOptions,
  cookieConflictMode = 'upsert-identity'
) {
  // textarea 取值始终按字符串写入，避免异常类型
  const textValue = value == null ? '' : String(value);

  if (storageType === STORAGE_TYPES.cookie) {
    return writeCookieViaApi(
      tab,
      key,
      textValue,
      cookieOptions || getCookieWriteOptions(),
      cookieConflictMode
    );
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

function getCookieWriteOptions(preferredCookie = null, options = {}) {
  const { applySideEffects = true } = options;
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
    if (applySideEffects) {
      cookieSecureCheckbox.checked = true;
    }
  }

  // Max-Age 有值：按相对秒数；否则若有保留的绝对过期则沿用；再否则为会话 cookie
  const expirationDate =
    maxAge === null && cookiePreservedExpirationDate !== null ? cookiePreservedExpirationDate : null;

  return {
    path,
    maxAge,
    domain,
    secure,
    sameSite,
    httpOnly,
    expirationDate,
    partitionKey: preferredCookie?.partitionKey,
  };
}

/** 确认框嵌套深度：用于连续确认取消时正确释放 busy */
let confirmDialogDepth = 0;
/** 行切换互斥，避免 focusin+click 并发弹确认 */
let rowSwitchLock = Promise.resolve();

function showConfirmDialog(options) {
  const { title, body, okText = '确认', danger = false } = options;

  // 已有确认框：不改文案、不叠加 depth，直接拒绝，避免污染当前对话框
  if (confirmDialog.open) {
    setStatus('请先处理当前确认对话框', 'empty');
    return Promise.resolve(false);
  }

  confirmTitleEl.textContent = title;
  confirmBodyEl.textContent = body;
  confirmOkBtn.textContent = okText;
  confirmOkBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  confirmDialog.classList.toggle('is-danger', Boolean(danger));

  const wasBusy = isBusy;
  confirmDialogDepth += 1;
  setBusy(true);

  return new Promise((resolve) => {
    const finish = (confirmed) => {
      confirmDialogDepth = Math.max(0, confirmDialogDepth - 1);
      if (confirmDialogDepth === 0) {
        setBusy(wasBusy);
      }
      resolve(confirmed);
    };

    const onClose = () => {
      confirmDialog.removeEventListener('close', onClose);
      finish(confirmDialog.returnValue === 'ok');
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
 * 空值 key 提示（与单行保存策略一致：不把空串当清空）
 * @param {string[]} keys
 * @returns {string}
 */
function formatEmptyValueKeysTip(keys) {
  const preview = keys.slice(0, 5).join(', ');
  const more = keys.length > 5 ? '…' : '';
  return `已跳过空值 key：${preview}${more}（清空请用删除 / 工具栏清空）`;
}

/**
 * 从 entries 中剔除空字符串值
 * @param {Record<string, string>} entries
 * @returns {{ entries: Record<string, string>, skipped: string[] }}
 */
function omitEmptyEntryValues(entries) {
  /** @type {Record<string, string>} */
  const next = {};
  /** @type {string[]} */
  const skipped = [];
  Object.keys(entries || {}).forEach((key) => {
    if (entries[key] === '') {
      skipped.push(key);
      return;
    }
    next[key] = entries[key];
  });
  return { entries: next, skipped };
}

/**
 * 从 cookie 详情列表中剔除空字符串值
 * @param {Array<{ name: string, value: string }>} cookies
 * @returns {{ cookies: typeof cookies, skipped: string[] }}
 */
function omitEmptyCookieValues(cookies) {
  /** @type {string[]} */
  const skipped = [];
  const next = (cookies || []).filter((item) => {
    if (item.value === '') {
      skipped.push(item.name);
      return false;
    }
    return true;
  });
  return { cookies: next, skipped };
}

/**
 * 从表格收集全部条目（跳过空 key 草稿；仅 local/session）
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
    entries[key] = row.value ?? '';
  });
  return entries;
}

/**
 * 从表格收集全部 cookie 详情（保留 Path/Domain/分区；含行内未保存编辑）
 * @returns {Array<ReturnType<typeof serializeCookieForExport>>}
 */
/**
 * 将属性栏当前选项合并为导出形态（用于脏属性或草稿）
 * @param {string} name
 * @param {string} value
 * @param {chrome.cookies.Cookie | null} [preferredCookie]
 * @returns {ReturnType<typeof serializeCookieForExport>}
 */
function serializeCookieOptionsForExport(name, value, preferredCookie = null) {
  const opts = getCookieWriteOptions(preferredCookie, { applySideEffects: false });
  // 与 serializeCookieForExport 对齐，统一导出 API 小写 sameSite
  const sameSiteApi = mapSameSiteToApi(opts.sameSite) || '';
  /** @type {ReturnType<typeof serializeCookieForExport>} */
  const item = {
    name,
    value,
    path: opts.path || '/',
    domain: opts.domain || '',
    hostOnly: !opts.domain,
    secure: Boolean(opts.secure),
    httpOnly: Boolean(opts.httpOnly),
    sameSite: sameSiteApi,
    session: opts.maxAge == null && opts.expirationDate == null,
    expirationDate: opts.expirationDate ?? null,
  };
  if (opts.maxAge != null && Number.isFinite(opts.maxAge)) {
    item.session = false;
    item.expirationDate = Date.now() / 1000 + opts.maxAge;
  }
  if (opts.partitionKey && typeof opts.partitionKey === 'object') {
    item.partitionKey = {
      topLevelSite: opts.partitionKey.topLevelSite || '',
      hasCrossSiteAncestor: Boolean(opts.partitionKey.hasCrossSiteAncestor),
    };
  }
  return item;
}

function collectAllCookieItemsFromTable() {
  /** @type {Array<ReturnType<typeof serializeCookieForExport>>} */
  const items = [];
  tableRows.forEach((row) => {
    syncRowModelFromDom(row.rowId);
    const name = row.key.trim();
    if (!name) {
      return;
    }
    const detail = getCookieDetailForRow(row);
    if (detail) {
      // 当前行属性栏有未保存改动时，以属性栏为准，避免「全部 JSON」带旧 identity
      if (row.rowId === activeRowId && isCookieBarDirtyForActiveRow()) {
        items.push(serializeCookieOptionsForExport(name, row.value ?? '', detail));
        return;
      }
      const serialized = serializeCookieForExport(detail);
      serialized.name = name;
      serialized.value = row.value ?? '';
      items.push(serialized);
      return;
    }
    // 草稿行：用属性栏当前选项
    items.push(serializeCookieOptionsForExport(name, row.value ?? '', null));
  });
  return items;
}

/**
 * 将对象或数组格式化为弹窗展示文本
 * @param {Record<string, string> | any[]} data
 * @returns {{ text: string, isJson: boolean, count: number }}
 */
function stringifyAllEntriesForDialog(data) {
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  try {
    return {
      text: stringifyForDisplay(data, 2),
      isJson: true,
      count,
    };
  } catch {
    return {
      text: JSON.stringify(data, null, 2),
      isJson: true,
      count,
    };
  }
}

/**
 * 将解析后的对象转为 string 条目表
 * @param {Record<string, any>} parsed
 * @returns {Record<string, string>}
 */
function mapParsedObjectToEntries(parsed) {
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
      entries[trimmedKey] = compressTextIfJson(value).text;
      return;
    }
    entries[trimmedKey] = JSON.stringify(value);
  });
  return entries;
}

/**
 * 解析全部 JSON：local/session 为对象；cookie 优先详情数组
 * @param {string} rawText
 * @returns {{ mode: 'entries', entries: Record<string, string> } | { mode: 'cookieDetails', cookies: NonNullable<ReturnType<typeof normalizeImportedCookieItem>>[] }}
 */
function parseAllDialogPayload(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('内容为空');
  }
  const parsed = JSON.parse(trimmed);

  if (currentStorageType === STORAGE_TYPES.cookie) {
    /** @type {any[] | null} */
    let list = null;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cookies)) {
      list = parsed.cookies;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 兼容旧版 { name: value }：按属性栏批量写（同名可能合并）
      return { mode: 'entries', entries: mapParsedObjectToEntries(parsed) };
    } else {
      throw new Error(
        'Cookie 全部 JSON 需为数组 [{ name, value, path, ... }] 或 { cookies: [...] }'
      );
    }
    const cookies = list.map((item) => normalizeImportedCookieItem(item)).filter(Boolean);
    // 空数组交由上层提示「≠ 清空存储」，避免抛硬错误
    return { mode: 'cookieDetails', cookies };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('根节点必须是 JSON 对象，例如 { "key": "value" }');
  }
  return { mode: 'entries', entries: mapParsedObjectToEntries(parsed) };
}

/**
 * JSON 编辑器滚到顶部并把光标置于开头（避免 focus 滚到文末）
 */
function resetJsonDialogEditorScrollTop() {
  const reset = () => {
    jsonDialogEditor.scrollTop = 0;
    jsonDialogEditor.scrollLeft = 0;
    try {
      jsonDialogEditor.setSelectionRange(0, 0);
    } catch {
      // readonly / 不支持选区时忽略
    }
  };
  reset();
  // 部分浏览器 focus 后会异步滚到光标，下一帧再校正一次
  requestAnimationFrame(reset);
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
  jsonDialogBaselineText = pretty.text;
  syncJsonDialogControls();
  updateJsonDialogMeta(pretty.text, pretty.isJson);

  if (!jsonDialog.open) {
    jsonDialog.showModal();
  }
  if (mode === 'edit') {
    jsonDialogEditor.focus();
  }
  resetJsonDialogEditorScrollTop();
}

/**
 * 打开表格全部数据的 JSON 查看 / 编辑弹窗
 * @param {'view' | 'edit'} mode
 */
function openAllJsonDialog(mode) {
  const typeLabel = getStorageTypeLabel(currentStorageType);
  /** @type {{ text: string, isJson: boolean, count: number }} */
  let pretty;
  /** @type {string} */
  let subtitle;

  if (currentStorageType === STORAGE_TYPES.cookie) {
    const cookies = collectAllCookieItemsFromTable();
    pretty = stringifyAllEntriesForDialog(cookies);
    subtitle = `${typeLabel} · 共 ${pretty.count} 条 cookies[]（含 path/domain/partitionKey；同名多 Path 不合并）`;
  } else {
    const entries = collectAllEntriesFromTable();
    pretty = stringifyAllEntriesForDialog(entries);
    subtitle = `${typeLabel} · 共 ${pretty.count} 个 key（值为字符串；编辑时可写对象，写入时会自动序列化）`;
  }

  jsonDialogScope = 'all';
  jsonDialogRowId = null;
  jsonDialogMode = mode;
  clearFormatStateForUi();
  clearJsonDialogToast();
  jsonDialogKeyEl.textContent = subtitle;
  jsonDialogEditor.value = pretty.text;
  jsonDialogBaselineText = pretty.text;
  syncJsonDialogControls();
  updateJsonDialogMeta(pretty.text, pretty.isJson);

  if (!jsonDialog.open) {
    jsonDialog.showModal();
  }
  if (mode === 'edit') {
    jsonDialogEditor.focus();
  }
  resetJsonDialogEditorScrollTop();
}

/**
 * 尝试关闭 JSON 弹窗（编辑态有改动时先确认）
 * @returns {Promise<boolean>} 是否已关闭
 */
async function handleJsonDialogCloseRequest() {
  // 写入/确认进行中忽略关闭，避免打断 showConfirmDialog
  if (isBusy) {
    return false;
  }
  if (
    jsonDialogMode === 'edit' &&
    jsonDialogEditor.value !== jsonDialogBaselineText
  ) {
    const confirmed = await showConfirmDialog({
      title: '关闭编辑？',
      body: '弹窗内有未保存的修改，关闭将丢弃这些更改（不会写入页面存储）。',
      okText: '丢弃并关闭',
      danger: true,
    });
    if (!confirmed) {
      return false;
    }
  }
  closeJsonDialog();
  return true;
}

/**
 * 点击遮罩关闭 JSON 弹窗
 */
async function handleJsonDialogBackdropClose() {
  await handleJsonDialogCloseRequest();
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
  // 关闭弹窗时清空格式化还原态，避免行内保存误用弹窗内展开态
  clearFormatStateForUi();
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
    let isJson;
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
  void setActiveRow(rowId, { syncCookie: true, skipAttrConfirm: true });
  if (!silentStatus) {
    setStatus(
      compressed.minified ? '已压缩并写回行' : '已写回行（非合法 JSON，未压缩）',
      compressed.minified ? 'success' : 'empty'
    );
  }
  return rowId;
}

/**
 * 将全部 JSON 批量写入页面存储（只覆盖出现的条目，不删除缺失项）
 */
async function handleJsonDialogApplyAll() {
  if (jsonDialogMode !== 'edit' || jsonDialogScope !== 'all' || isBusy) {
    return;
  }

  // 先持锁再确认，避免确认结束后短暂解锁可再点关闭/写入
  setBusy(true);
  try {
    const canDiscard = await confirmDiscardDirtyEdits('写入全部');
    if (!canDiscard) {
      setStatus('已取消写入全部', 'empty');
      return;
    }
    if (jsonDialogMode !== 'edit' || jsonDialogScope !== 'all' || !jsonDialog.open) {
      setStatus('写入全部已取消（弹窗已关闭）', 'empty');
      return;
    }

    // 用户已同意丢弃未保存属性：兼容模式批量写入前恢复为已写入详情，避免脏属性栏误用
    if (currentStorageType === STORAGE_TYPES.cookie && activeRowId) {
      const activeRow = tableRows.find((item) => item.rowId === activeRowId);
      const savedCookie = activeRow ? getCookieDetailForRow(activeRow) : null;
      if (savedCookie) {
        applyCookieDetailsToForm(savedCookie);
      }
    }

    /** @type {{ mode: 'entries', entries: Record<string, string> } | { mode: 'cookieDetails', cookies: NonNullable<ReturnType<typeof normalizeImportedCookieItem>>[] }} */
    let payload;
    try {
      // 写入前若处于展开态，先按还原逻辑压缩
      const prepared = prepareValueForWrite(jsonDialogEditor.value);
      payload = parseAllDialogPayload(prepared.text);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'JSON 解析失败', 'error');
      return;
    }

    /** @type {string} */
    let preview;
    /** @type {number} */
    let totalCount;
    /** @type {string} */
    let cookieTip = '';
    /** @type {string[]} */
    let skippedEmpty;

    if (payload.mode === 'cookieDetails') {
      const stripped = omitEmptyCookieValues(payload.cookies);
      payload = { mode: 'cookieDetails', cookies: stripped.cookies };
      skippedEmpty = stripped.skipped;
      totalCount = payload.cookies.length;
      if (!totalCount) {
        setStatus(
          skippedEmpty.length
            ? `${formatEmptyValueKeysTip(skippedEmpty)}；且没有其它可写入条目。清空存储请用工具栏「清空」`
            : '没有可写入的 cookie。全部 JSON 不会删除未出现的项；清空请用工具栏「清空」',
          'empty'
        );
        return;
      }
      preview = payload.cookies
        .slice(0, 8)
        .map(
          (item) =>
            `- ${item.name}（path=${item.path}${item.domain ? `, domain=${item.domain}` : ''}，${item.value.length} 字符）`
        )
        .join('\n');
      cookieTip = '\n\n将按每条自身的 Path/Domain/分区精确写入（同名多 Path 互不影响）。';
    } else {
      const stripped = omitEmptyEntryValues(payload.entries);
      payload = { mode: 'entries', entries: stripped.entries };
      skippedEmpty = stripped.skipped;
      totalCount = Object.keys(payload.entries).length;
      if (!totalCount) {
        setStatus(
          skippedEmpty.length
            ? `${formatEmptyValueKeysTip(skippedEmpty)}；且没有其它可写入条目。清空存储请用工具栏「清空」`
            : '没有可写入的 key。全部 JSON 不会删除未出现的项；清空请用工具栏「清空」',
          'empty'
        );
        return;
      }
      preview = Object.keys(payload.entries)
        .slice(0, 8)
        .map((key) => `- ${key}（${payload.entries[key].length} 字符）`)
        .join('\n');
      if (currentStorageType === STORAGE_TYPES.cookie) {
        cookieTip =
          '\n\n兼容模式：{ name: value } 将使用上方属性栏 Path/Domain 批量写入（只能表达一条 identity）。建议改用 cookies[] 数组。';
      }
    }

    const moreTip = totalCount > 8 ? `\n…共 ${totalCount} 条` : '';
    const skipTip = skippedEmpty.length
      ? `\n\n将跳过 ${skippedEmpty.length} 个空值（清空请用删除）。`
      : '';
    const confirmed = await showConfirmDialog({
      title: `确认写入全部到 ${getStorageTypeLabel(currentStorageType)}？`,
      body: `将写入 / 覆盖以下条目（不会删除未出现在 JSON 中的项）：\n${preview}${moreTip}${skipTip}${cookieTip}`,
      okText: '确认写入',
      danger: true,
    });
    if (!confirmed) {
      setStatus('已取消写入全部', 'empty');
      return;
    }

    setStatus('批量写入中...');
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    let result;
    if (payload.mode === 'cookieDetails') {
      result = await writeCookiesDetailedBatchViaApi(tab, payload.cookies);
    } else if (currentStorageType === STORAGE_TYPES.cookie) {
      result = await writeCookiesBatchViaApi(tab, payload.entries, getCookieWriteOptions());
    } else {
      result = await executeInTab(tab.id, writePageStorageBatch, [
        currentStorageType,
        payload.entries,
        null,
      ]);
    }

    clearFormatStateForUi();
    closeJsonDialog();
    const successCount = result?.successCount ?? totalCount;
    const failCount = result?.failCount ?? 0;
    const skipSuffix = skippedEmpty.length ? `，跳过空值 ${skippedEmpty.length}` : '';
    if (failCount > 0) {
      setStatus(
        `批量写入完成：成功 ${successCount}，失败 ${failCount}${skipSuffix}`,
        'error'
      );
    } else {
      setStatus(`已写入全部 ${successCount} 条${skipSuffix}`, 'success');
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
  if (jsonDialogMode !== 'edit' || isBusy) {
    return;
  }
  if (jsonDialogScope === 'all') {
    await handleJsonDialogApplyAll();
    return;
  }

  if (!jsonDialogRowId) {
    setStatus('没有可保存的行', 'error');
    return;
  }

  const targetRowId = jsonDialogRowId;
  const targetRow = tableRows.find((item) => item.rowId === targetRowId) || null;
  const previousValue = targetRow ? targetRow.value : '';
  const previousDomValue = getRowValueTextarea(targetRowId)?.value ?? previousValue;

  // 入口即持锁，避免 apply 后、行保存前可关闭弹窗造成「已写回行但仍在保存」
  setBusy(true);
  let appliedRowId = null;
  try {
    appliedRowId = applyJsonDialogToRow({ closeDialog: false, silentStatus: true });
    if (!appliedRowId) {
      return;
    }
    const saved = await handleRowSave(appliedRowId, { holdBusy: true });
    if (!saved) {
      if (targetRow) {
        targetRow.value = previousValue;
      }
      const textarea = getRowValueTextarea(appliedRowId);
      if (textarea) {
        textarea.value = previousDomValue;
      }
      syncRowModelFromDom(appliedRowId);
      return;
    }
    closeJsonDialog();
  } finally {
    setBusy(false);
  }
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
  jsonDialogEditor.value =
    jsonDialogScope === 'all'
      ? currentStorageType === STORAGE_TYPES.cookie
        ? '[\n]'
        : '{\n}'
      : '';
  updateJsonDialogMeta(
    jsonDialogEditor.value,
    jsonDialogScope === 'all'
  );
  setStatus('已清空编辑内容（尚未写入存储）', 'empty');
  jsonDialogEditor.focus();
}

/**
 * 弹窗「删除」：确认并删除成功后再关窗
 */
async function handleJsonDialogDelete() {
  if (jsonDialogMode !== 'edit' || jsonDialogScope !== 'row' || !jsonDialogRowId || isBusy) {
    return;
  }
  const rowId = jsonDialogRowId;
  await handleRowDelete(rowId);
  // 删除成功后行通常已不在；若弹窗仍开着且目标行已没了则关闭
  if (!tableRows.some((row) => row.rowId === rowId)) {
    closeJsonDialog();
  }
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
    /(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*(\{[\s\S]*}|\[[\s\S]*])\s*;?\s*$/
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
 * 设置状态文案到 #statusText；JSON 弹窗打开时同步在弹窗内提示
 * @param {string} text
 * @param {'success' | 'error' | 'empty' | 'pending' | ''} [type]
 */
function setStatus(text, type = '') {
  const nextType = type || (text ? 'pending' : '');
  statusTextEl.textContent = text;
  statusTextEl.className = `status${nextType ? ` is-${nextType}` : ''}`;

  if (!text) {
    clearJsonDialogToast();
    return;
  }

  if (nextType === 'error' || nextType === 'empty' || nextType === 'success') {
    statusTextEl.classList.remove('is-flash');
    void statusTextEl.offsetWidth;
    statusTextEl.classList.add('is-flash');
  }

  // 弹窗打开时底部提示被挡住，改在弹窗内同步展示
  if (jsonDialog.open) {
    showJsonDialogToast(text, nextType);
  }
}

/**
 * 在 JSON 弹窗内显示操作提示
 * @param {string} text
 * @param {string} [type]
 */
function showJsonDialogToast(text, type = 'success') {
  if (!(jsonDialogToastEl instanceof HTMLElement)) {
    return;
  }
  window.clearTimeout(jsonDialogToastTimer);
  jsonDialogToastEl.hidden = false;
  jsonDialogToastEl.textContent = text;
  jsonDialogToastEl.className = `json-dialog-toast is-${type || 'pending'}`;
  jsonDialogToastEl.classList.remove('is-flash');
  void jsonDialogToastEl.offsetWidth;
  jsonDialogToastEl.classList.add('is-flash');
  // 错误提示保留更久，避免被挡住后一闪而过
  const hideMs = type === 'error' ? 6000 : type === 'pending' ? 0 : 2200;
  if (hideMs > 0) {
    jsonDialogToastTimer = window.setTimeout(() => {
      clearJsonDialogToast();
    }, hideMs);
  }
}

/**
 * 清除 JSON 弹窗内提示
 */
function clearJsonDialogToast() {
  window.clearTimeout(jsonDialogToastTimer);
  jsonDialogToastTimer = 0;
  if (!(jsonDialogToastEl instanceof HTMLElement)) {
    return;
  }
  jsonDialogToastEl.hidden = true;
  jsonDialogToastEl.textContent = '';
  jsonDialogToastEl.className = 'json-dialog-toast';
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
  keysFilterInput.disabled = busy;
  if (keysFilterClearBtn instanceof HTMLButtonElement) {
    keysFilterClearBtn.disabled = busy;
  }
  if (busy) {
    closeFilterDropdown();
  }
  // Cookie 属性栏一并锁定，避免写入中改表单
  [
    cookiePathInput,
    cookieMaxAgeInput,
    cookieDomainInput,
    cookieSameSiteSelect,
    cookieSecureCheckbox,
    cookieHttpOnlyCheckbox,
    cookieMakeSessionBtn,
  ].forEach((el) => {
    if (
      el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement
    ) {
      el.disabled = busy;
    }
  });
  // JSON 弹层操作一并锁定，避免与确认框/保存互抢
  [
    jsonFormatBtn,
    jsonCompressBtn,
    jsonCopyBtn,
    jsonPasteBtn,
    jsonClearBtn,
    jsonSaveBtn,
    jsonDeleteBtn,
    jsonCloseBtn,
  ].forEach((el) => {
    if (el instanceof HTMLButtonElement) {
      el.disabled = busy;
    }
  });
  if (jsonDialogEditor instanceof HTMLTextAreaElement) {
    jsonDialogEditor.disabled = busy;
  }
  // 忙碌时禁止切换类型，避免半写入状态交错
  storageTypeTabsEl.querySelectorAll('.tab-item').forEach((button) => {
    if (button instanceof HTMLButtonElement) {
      button.disabled = busy;
    }
  });
  storageTableBody
    .querySelectorAll(
      '[data-action="save"], [data-action="delete"], [data-action="edit-json"], [data-action="paste"], .row-key, .row-value'
    )
    .forEach((el) => {
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.disabled = busy;
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
 * 规范化筛选历史列表（最多 FILTER_HISTORY_LIMIT 条）
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizeFilterHistoryList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, FILTER_HISTORY_LIMIT);
}

/**
 * 从 storage 加载当前类型的筛选历史到内存
 * @returns {Promise<string[]>}
 */
async function loadFilterHistoryCache() {
  const field = getFilterHistoryField(currentStorageType);
  const stored = await chrome.storage.local.get(field);
  filterHistoryCache = normalizeFilterHistoryList(stored[field]);
  return filterHistoryCache;
}

/**
 * 写入筛选历史（去重置顶，最多 5 条）
 * @param {string} keyword
 */
async function pushFilterHistory(keyword) {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) {
    return;
  }
  const field = getFilterHistoryField(currentStorageType);
  const previousList = filterHistoryCache.length
    ? filterHistoryCache
    : normalizeFilterHistoryList((await chrome.storage.local.get(field))[field]);
  const nextList = [trimmed, ...previousList.filter((item) => item !== trimmed)].slice(
    0,
    FILTER_HISTORY_LIMIT
  );
  filterHistoryCache = nextList;
  await chrome.storage.local.set({ [field]: nextList });
  refreshFilterSuggestions();
}

/**
 * 收集当前表格去重后的 key 列表（备选）
 * @returns {string[]}
 */
function collectCurrentTableKeysForFilter() {
  const seen = new Set();
  const keys = [];
  for (const row of tableRows) {
    const keyText = String(row.key || '').trim();
    if (!keyText || seen.has(keyText)) {
      continue;
    }
    seen.add(keyText);
    keys.push(keyText);
  }
  return keys;
}

/**
 * 同步清除按钮显隐
 */
function syncFilterClearButton() {
  if (!(keysFilterClearBtn instanceof HTMLButtonElement) || !(keysFilterInput instanceof HTMLInputElement)) {
    return;
  }
  keysFilterClearBtn.hidden = !keysFilterInput.value;
}

/**
 * 构建筛选下拉数据：历史 + 当前 key（完整备选，不随输入过滤）
 * @returns {{ history: string[], keys: string[], flat: Array<{ kind: string, value: string }> }}
 */
function buildFilterSuggestionGroups() {
  const seen = new Set();
  const history = [];
  for (const item of filterHistoryCache) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    history.push(item);
  }
  const keys = [];
  for (const keyText of collectCurrentTableKeysForFilter()) {
    if (seen.has(keyText)) {
      continue;
    }
    seen.add(keyText);
    keys.push(keyText);
  }
  const flat = [
    ...history.map((value) => ({ kind: 'history', value })),
    ...keys.map((value) => ({ kind: 'key', value })),
  ];
  return { history, keys, flat };
}

/**
 * 刷新筛选下拉 DOM（不强制展开）
 */
function refreshFilterSuggestions() {
  if (!(keysFilterDropdown instanceof HTMLElement)) {
    return;
  }
  const groups = buildFilterSuggestionGroups();
  filterDropdownFlatOptions = groups.flat;

  if (!groups.flat.length) {
    keysFilterDropdown.innerHTML = `<div class="keys-filter-empty">暂无备选</div>`;
    filterDropdownActiveIndex = -1;
    return;
  }

  const parts = [];
  let flatIndex = 0;
  if (groups.history.length) {
    parts.push(`<div class="keys-filter-group-label">最近筛选</div>`);
    groups.history.forEach((value) => {
      parts.push(
        `<button type="button" class="keys-filter-option" role="option" data-index="${flatIndex}" data-kind="history" title="${escapeHtml(value)}">${escapeHtml(value)}</button>`
      );
      flatIndex += 1;
    });
  }
  if (groups.keys.length) {
    parts.push(`<div class="keys-filter-group-label">当前 Key</div>`);
    groups.keys.forEach((value) => {
      parts.push(
        `<button type="button" class="keys-filter-option" role="option" data-index="${flatIndex}" data-kind="key" title="${escapeHtml(value)}">${escapeHtml(value)}</button>`
      );
      flatIndex += 1;
    });
  }
  keysFilterDropdown.innerHTML = parts.join('');

  if (filterDropdownActiveIndex >= filterDropdownFlatOptions.length) {
    filterDropdownActiveIndex = filterDropdownFlatOptions.length - 1;
  }
  syncFilterDropdownActiveOption();
}

/**
 * 同步下拉高亮样式与滚动
 */
function syncFilterDropdownActiveOption() {
  if (!(keysFilterDropdown instanceof HTMLElement)) {
    return;
  }
  const options = Array.from(keysFilterDropdown.querySelectorAll('.keys-filter-option'));
  options.forEach((el, index) => {
    el.classList.toggle('is-active', index === filterDropdownActiveIndex);
  });
  const activeEl = options[filterDropdownActiveIndex];
  if (activeEl instanceof HTMLElement) {
    activeEl.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * 取消待执行的下拉关闭
 */
function cancelFilterDropdownClose() {
  window.clearTimeout(filterDropdownBlurTimer);
  filterDropdownBlurTimer = 0;
}

/**
 * 延后关闭下拉（便于移入下拉或再次点输入框）
 * @param {number} [delayMs]
 */
function scheduleFilterDropdownClose(delayMs = 150) {
  cancelFilterDropdownClose();
  filterDropdownBlurTimer = window.setTimeout(() => {
    // 指针仍在筛选区域内则不关
    if (keysFilterWrap instanceof HTMLElement && keysFilterWrap.matches(':hover')) {
      return;
    }
    closeFilterDropdown();
  }, delayMs);
}

/**
 * 展开筛选下拉
 */
function openFilterDropdown() {
  if (!(keysFilterDropdown instanceof HTMLElement) || isBusy) {
    return;
  }
  cancelFilterDropdownClose();
  refreshFilterSuggestions();
  filterDropdownOpen = true;
  keysFilterDropdown.hidden = false;
  if (keysFilterWrap instanceof HTMLElement) {
    keysFilterWrap.classList.add('is-open');
  }
  if (keysFilterInput instanceof HTMLInputElement) {
    keysFilterInput.setAttribute('aria-expanded', 'true');
  }
  // 不默认高亮首项，避免 Enter 误选建议
  syncFilterDropdownActiveOption();
}

/**
 * 收起筛选下拉
 */
function closeFilterDropdown() {
  cancelFilterDropdownClose();
  filterDropdownOpen = false;
  filterDropdownActiveIndex = -1;
  if (keysFilterDropdown instanceof HTMLElement) {
    keysFilterDropdown.hidden = true;
  }
  if (keysFilterWrap instanceof HTMLElement) {
    keysFilterWrap.classList.remove('is-open');
  }
  if (keysFilterInput instanceof HTMLInputElement) {
    keysFilterInput.setAttribute('aria-expanded', 'false');
  }
}

/**
 * 筛选竞态后按「当前最终 keyword」纠偏选中行与 Cookie 属性栏
 */
async function reconcileActiveRowAfterFilterRace() {
  const visibleRows = tableRows.filter(isRowMatchFilter);
  if (activeRowId && !visibleRows.some((row) => row.rowId === activeRowId)) {
    await setActiveRow(visibleRows[0]?.rowId || null, {
      syncCookie: true,
      skipAttrConfirm: true,
    });
    return;
  }
  if (activeRowId) {
    await setActiveRow(activeRowId, { syncCookie: true, skipAttrConfirm: true });
  }
}

/**
 * 应用筛选关键字并刷新表格
 * @param {string} keyword
 * @param {{ pushHistory?: boolean, closeDropdown?: boolean }} [options]
 */
async function applyKeysFilterKeyword(keyword, options = {}) {
  const { pushHistory = false, closeDropdown = true } = options;
  if (!(keysFilterInput instanceof HTMLInputElement)) {
    return;
  }
  const nextKeyword = String(keyword ?? '');
  const previousFilterKeyword = filterKeyword;
  const seq = ++filterInputSeq;

  tableRows.forEach((row) => syncRowModelFromDom(row.rowId));

  // 预判：应用后当前行是否仍可见（确认前不改 UI，避免先跳变）
  const wouldHideActive =
    Boolean(activeRowId) &&
    !tableRows.some(
      (row) => row.rowId === activeRowId && isRowMatchFilterWithKeyword(row, nextKeyword)
    );

  if (wouldHideActive && isCookieBarDirtyForActiveRow()) {
    const canDiscard = await confirmDiscardDirtyEdits('筛选');
    if (seq !== filterInputSeq) {
      return;
    }
    if (!canDiscard) {
      // 取消：恢复进入前的筛选词，保持当前行与属性栏
      keysFilterInput.value = previousFilterKeyword;
      filterKeyword = previousFilterKeyword;
      syncFilterClearButton();
      if (closeDropdown) {
        closeFilterDropdown();
      } else {
        refreshFilterSuggestions();
      }
      renderStorageTable();
      void setActiveRow(activeRowId, { syncCookie: false, skipAttrConfirm: true });
      return;
    }
  }

  keysFilterInput.value = nextKeyword;
  filterKeyword = nextKeyword;
  syncFilterClearButton();
  if (closeDropdown) {
    closeFilterDropdown();
  } else {
    refreshFilterSuggestions();
  }

  if (seq !== filterInputSeq) {
    return;
  }

  renderStorageTable();
  const visibleRows = tableRows.filter(isRowMatchFilter);
  if (activeRowId && !visibleRows.some((row) => row.rowId === activeRowId)) {
    const nextId = visibleRows[0]?.rowId || null;
    const previousActiveId = activeRowId;
    // 切行前再校验序号，避免过期回调改 active / 属性栏
    if (seq !== filterInputSeq) {
      return;
    }
    const switched = await setActiveRow(nextId, { syncCookie: true, skipAttrConfirm: true });
    if (seq !== filterInputSeq) {
      await reconcileActiveRowAfterFilterRace();
      return;
    }
    if (!switched) {
      keysFilterInput.value = previousFilterKeyword;
      filterKeyword = previousFilterKeyword;
      filterInputSeq += 1;
      syncFilterClearButton();
      renderStorageTable();
      void setActiveRow(previousActiveId, { syncCookie: true, skipAttrConfirm: true });
      return;
    }
  } else if (activeRowId && seq === filterInputSeq) {
    void setActiveRow(activeRowId, { syncCookie: false, skipAttrConfirm: true });
  }

  if (pushHistory && seq === filterInputSeq) {
    void pushFilterHistory(nextKeyword);
  }
}

/**
 * 选中下拉某一项
 * @param {string} value
 */
function selectFilterSuggestion(value) {
  void applyKeysFilterKeyword(value, { pushHistory: true, closeDropdown: true });
}

/**
 * 清除筛选
 */
function clearKeysFilter() {
  void applyKeysFilterKeyword('', { pushHistory: false, closeDropdown: true });
  if (keysFilterInput instanceof HTMLInputElement) {
    keysFilterInput.focus();
  }
}

/**
 * 恢复筛选框为空，并加载当前类型的筛选历史备选
 * @returns {Promise<void>}
 */
async function restoreDefaultFilterKeyword() {
  await loadFilterHistoryCache();
  filterKeyword = '';
  if (keysFilterInput instanceof HTMLInputElement) {
    keysFilterInput.value = '';
  }
  syncFilterClearButton();
  refreshFilterSuggestions();
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
 * 行是否匹配筛选（草稿始终显示；匹配 Key / 值；Cookie 另匹配 Path/Domain）
 * @param {TableRowModel} row
 * @returns {boolean}
 */
/**
 * 按指定关键字判断行是否匹配筛选
 * @param {TableRowModel} row
 * @param {string} keywordRaw
 * @returns {boolean}
 */
function isRowMatchFilterWithKeyword(row, keywordRaw) {
  if (row.isDraft) {
    return true;
  }
  const keyword = String(keywordRaw || '').trim().toLowerCase();
  if (!keyword) {
    return true;
  }
  const keyText = (row.key || '').toLowerCase();
  const valueText = (row.value || '').toLowerCase();
  if (keyText.includes(keyword) || valueText.includes(keyword)) {
    return true;
  }
  if (currentStorageType === STORAGE_TYPES.cookie) {
    const cookie = getCookieDetailForRow(row);
    const name = (cookie?.name || '').toLowerCase();
    const path = (cookie?.path || '/').toLowerCase();
    const domain = (cookie?.domain || '').toLowerCase();
    return name.includes(keyword) || path.includes(keyword) || domain.includes(keyword);
  }
  return false;
}

function isRowMatchFilter(row) {
  return isRowMatchFilterWithKeyword(row, filterKeyword);
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
  if (cookie.partitionKey && cookie.partitionKey.topLevelSite) {
    badges.push(
      `<span class="row-badge is-partition" title="分区 topLevelSite=${escapeHtml(cookie.partitionKey.topLevelSite)}">分区</span>`
    );
  }
  return badges.join('');
}

/**
 * 行基线值（上次从页面加载的值）
 * @param {TableRowModel} row
 * @returns {string}
 */
function getRowBaselineValue(row) {
  if (row.isDraft) {
    return '';
  }
  if (currentStorageType === STORAGE_TYPES.cookie) {
    if (row.cacheKey && Object.prototype.hasOwnProperty.call(pageEntriesCache, row.cacheKey)) {
      return pageEntriesCache[row.cacheKey] ?? '';
    }
    return getCookieDetailForRow(row)?.value ?? '';
  }
  if (row.originKey != null && Object.prototype.hasOwnProperty.call(pageEntriesCache, row.originKey)) {
    return pageEntriesCache[row.originKey] ?? '';
  }
  return '';
}

/**
 * 行是否有未保存编辑（草稿有内容，或 key/值相对基线有变）
 * @param {TableRowModel} row
 * @returns {boolean}
 */
function isRowDirty(row) {
  if (row.isDraft) {
    return Boolean(row.key.trim() || row.value);
  }
  const currentKey = row.key.trim();
  const originKey = row.originKey || '';
  if (currentKey !== originKey) {
    return true;
  }
  return (row.value ?? '') !== getRowBaselineValue(row);
}

/**
 * 收集未保存行（先同步 DOM）
 * @returns {TableRowModel[]}
 */
function collectDirtyRows() {
  tableRows.forEach((row) => syncRowModelFromDom(row.rowId));
  return tableRows.filter((row) => isRowDirty(row));
}

/**
 * 若有未保存更改则确认是否丢弃
 * @param {string} actionLabel
 * @returns {Promise<boolean>}
 */
async function confirmDiscardDirtyEdits(actionLabel) {
  const dirtyRows = collectDirtyRows();
  const cookieAttrDirty = isCookieBarDirtyForActiveRow();
  if (!dirtyRows.length && !cookieAttrDirty) {
    return true;
  }
  const parts = [];
  if (dirtyRows.length) {
    parts.push(`${dirtyRows.length} 处未保存编辑或草稿`);
  }
  if (cookieAttrDirty) {
    parts.push('当前行 Cookie 属性未保存');
  }
  return showConfirmDialog({
    title: '有未保存的更改',
    body: `「${actionLabel}」将丢弃：${parts.join('；')}。继续？`,
    okText: '继续',
    danger: true,
  });
}

/**
 * 渲染单行 HTML
 * @param {TableRowModel} row
 * @returns {string}
 */
function buildRowHtml(row) {
  const isActive = row.rowId === activeRowId;
  const dirty = isRowDirty(row);
  const classNames = [
    isActive ? 'is-active' : '',
    row.isDraft ? 'is-draft' : '',
    dirty && !row.isDraft ? 'is-dirty' : '',
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
  if (dirty && !row.isDraft) {
    badges = `${badges}<span class="row-badge is-dirty" title="尚未保存到页面">未保存</span>`;
  }
  const badgesBlock = badges ? `<div class="row-badges">${badges}</div>` : '';

  return `<tr class="${classNames}" data-row-id="${escapeHtml(row.rowId)}">
    <td class="col-key">
      <div class="row-key-wrap">
        <input class="row-key" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(row.key)}" aria-label="Key" ${isBusy ? 'disabled' : ''} />
        ${badgesBlock}
      </div>
    </td>
    <td class="col-value">
      <textarea class="row-value" spellcheck="false" aria-label="值" ${isBusy ? 'disabled' : ''}>${escapeHtml(row.value)}</textarea>
    </td>
    <td class="col-actions">
      <div class="row-actions">
        <button class="btn btn-ghost" type="button" data-action="edit-json" title="以 JSON 格式编辑" ${isBusy ? 'disabled' : ''}>编辑</button>
        <button class="btn btn-ghost" type="button" data-action="copy" title="复制值">复制</button>
        <button class="btn btn-ghost" type="button" data-action="paste" title="粘贴到值" ${isBusy ? 'disabled' : ''}>粘贴</button>
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

  // 重渲染后同步 busy 禁用态（buildRowHtml 只覆盖部分控件）
  if (isBusy) {
    setBusy(true);
  }
  refreshFilterSuggestions();
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
 * 当前选中行的 Cookie 属性栏是否相对已写入结果有未保存改动
 * @returns {boolean}
 */
function isCookieBarDirtyForActiveRow() {
  if (currentStorageType !== STORAGE_TYPES.cookie || !activeRowId) {
    return false;
  }
  const row = tableRows.find((item) => item.rowId === activeRowId);
  if (!row || row.isDraft) {
    return false;
  }
  const cookie = getCookieDetailForRow(row);
  if (!cookie) {
    return false;
  }
  const next = getCookieWriteOptions(cookie, { applySideEffects: false });
  const oldPath = cookie.path || '/';
  if (oldPath !== (next.path || '/')) {
    return true;
  }
  const oldDomain = cookie.hostOnly ? '' : String(cookie.domain || '').replace(/^\./, '');
  const nextDomain = (next.domain || '').replace(/^\./, '');
  if (oldDomain !== nextDomain) {
    return true;
  }
  if (Boolean(cookie.httpOnly) !== Boolean(next.httpOnly)) {
    return true;
  }
  if (Boolean(cookie.secure) !== Boolean(next.secure)) {
    return true;
  }
  if (mapSameSiteFromApi(cookie.sameSite) !== (next.sameSite || '')) {
    return true;
  }
  const oldExpireSig =
    cookie.session || !cookie.expirationDate
      ? 'session'
      : `abs:${Math.floor(cookie.expirationDate)}`;
  const nextExpireSig =
    next.maxAge !== null && Number.isFinite(next.maxAge)
      ? `max:${next.maxAge}`
      : next.expirationDate != null && Number.isFinite(next.expirationDate)
        ? `abs:${Math.floor(next.expirationDate)}`
        : 'session';
  return oldExpireSig !== nextExpireSig;
}

/**
 * 设为当前操作行并同步 cookie 属性
 * @param {string | null} rowId
 * @param {{ syncCookie?: boolean, skipAttrConfirm?: boolean }} [options]
 * @returns {Promise<boolean>} 是否完成切换
 */
async function setActiveRow(rowId, options = {}) {
  const run = async () => {
    const { syncCookie = true, skipAttrConfirm = false } = options;

    if (
      !skipAttrConfirm &&
      syncCookie &&
      currentStorageType === STORAGE_TYPES.cookie &&
      activeRowId &&
      rowId !== activeRowId &&
      isCookieBarDirtyForActiveRow()
    ) {
      const confirmed = await showConfirmDialog({
        title: 'Cookie 属性未保存',
        body: '当前行的 Cookie 属性已修改但未保存，切换行将丢失这些修改。继续？',
        okText: '继续切换',
        danger: true,
      });
      if (!confirmed) {
        setStatus('已取消切换行（请先点「保存」写入属性）', 'empty');
        return false;
      }
    }

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
    return true;
  };

  const previous = rowSwitchLock;
  let release = () => {};
  rowSwitchLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
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
  // Cookie 优先用 cacheKey，避免同名多 Path 刷新后选中错行
  const preferKey =
    preferActiveKey ||
    previousActive?.cacheKey ||
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
  // 若默认/残留筛选把选中行滤掉，改落到首条可见行
  const visibleRows = tableRows.filter(isRowMatchFilter);
  if (nextActiveId && !visibleRows.some((row) => row.rowId === nextActiveId)) {
    nextActiveId = visibleRows[0]?.rowId || null;
    activeRowId = nextActiveId;
  }
  if (nextActiveId) {
    await setActiveRow(nextActiveId, { syncCookie: true, skipAttrConfirm: true });
  } else if (currentStorageType === STORAGE_TYPES.cookie) {
    clearCookiePreservedExpiration();
  }

  return pageData;
}

/**
 * 追加草稿空行
 */
async function handleAddRow() {
  if (isBusy) {
    return;
  }
  const draft = createDraftRow();
  tableRows.push(draft);
  renderStorageTable();
  const switched = await setActiveRow(draft.rowId, { syncCookie: true });
  if (!switched) {
    tableRows = tableRows.filter((row) => row.rowId !== draft.rowId);
    renderStorageTable();
    return;
  }
  getRowKeyInput(draft.rowId)?.focus();
  setStatus('已追加草稿行，填写后点保存写入', 'empty');
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
        setStatus('复制失败，请手动选中复制', 'error');
        return;
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

  if (!navigator.clipboard?.readText) {
    setStatus(
      '粘贴失败：请重新加载扩展后再试，或直接在输入框按 Ctrl/Cmd + V',
      'error'
    );
    textarea.focus();
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setStatus('剪贴板为空（或非文本内容）', 'empty');
      return;
    }
    textarea.value = text;
    syncRowModelFromDom(rowId);
    clearFormatStateForUi();
    refreshRowDirtyIndicator(rowId);
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
    // 精确 identity：同 path+domain+partition 才算覆盖同一条
    const preferredCookie = getCookieDetailForRow(row);
    const cookieOptions = getCookieWriteOptions(preferredCookie, { applySideEffects: false });
    const all = await collectTabCookies(tab);
    const nextPath = cookieOptions.path || '/';
    const nextDomainNorm = (cookieOptions.domain || '').replace(/^\./, '');
    const nextPartitionSig = serializePartitionKeyPart(cookieOptions.partitionKey);
    const sameIdentity = all.find(
      (cookie) =>
        cookie.name === key &&
        isCookieSameIdentity(cookie, nextPath, nextDomainNorm, nextPartitionSig)
    );
    if (sameIdentity) {
      const sameNameOthers = all.filter(
        (cookie) =>
          cookie.name === key && buildCookieCacheKey(cookie) !== buildCookieCacheKey(sameIdentity)
      );
      return {
        value: sameIdentity.value,
        httpOnly: Boolean(sameIdentity.httpOnly),
        cookie: sameIdentity,
        sameNameCount: sameNameOthers.length,
        sameNameConflict: false,
      };
    }
    // 草稿/改名新建：提示同名其他 Path/分区仍在（不拿其它 Path 的值/属性做对比）
    const sameName = all.filter((cookie) => cookie.name === key);
    if (sameName.length) {
      return {
        value: null,
        httpOnly: false,
        cookie: null,
        sameNameConflict: true,
        sameNameCount: sameName.length,
      };
    }
    return { value: null, httpOnly: false, cookie: null, sameNameCount: 0 };
  }
  return readStorageValue(tab, currentStorageType, key);
}

/**
 * 行内保存
 * @param {string} rowId
 * @param {{ holdBusy?: boolean }} [options] holdBusy：调用方已持锁时勿在 finally 释放
 * @returns {Promise<boolean>} 是否写入成功
 */
async function handleRowSave(rowId, options = {}) {
  const { holdBusy = false } = options;
  if (isBusy && !holdBusy) {
    return false;
  }

  // 尽早持锁，避免 prepare/校验窗口被关闭或连点打断
  const ownedBusy = !isBusy;
  if (ownedBusy) {
    setBusy(true);
  }

  try {
    syncRowModelFromDom(rowId);
    const row = tableRows.find((item) => item.rowId === rowId);
    if (!row) {
      return false;
    }

    const key = row.key.trim();
    if (!key) {
      setStatus('请输入 key', 'error');
      getRowKeyInput(rowId)?.focus();
      return false;
    }

    const textarea = getRowValueTextarea(rowId);
    if (!textarea) {
      // 行可能被筛选隐藏：用模型值继续，避免静默失败
      if (!row.value) {
        setStatus('没有可写入的值（行可能被筛选隐藏且值为空）', 'error');
        return false;
      }
    } else if (!textarea.value) {
      setStatus('请先粘贴或输入要写入的值（空字符串拒绝写入）', 'error');
      textarea.focus();
      return false;
    }

    ensureFormatBoundToRow(rowId);
    const prepared = prepareValueForWrite(textarea ? textarea.value : row.value);
    const value = prepared.text;
    const keptEditsOnWrite = formatExpandDirty && prepared.restoredCount > 0;

    // 保存前先把压缩结果回写到单元格，与「编辑自动格式化」对称
    if (textarea && value !== textarea.value) {
      textarea.value = value;
      syncRowModelFromDom(rowId);
    } else if (!textarea) {
      row.value = value;
    }

    const isStorageRename =
      !row.isDraft &&
      row.originKey != null &&
      row.originKey !== key &&
      currentStorageType !== STORAGE_TYPES.cookie;

    const oldCookieDetail =
      currentStorageType === STORAGE_TYPES.cookie && !row.isDraft
        ? getCookieDetailForRow(row)
        : null;

    const tab = await getActiveTab();
    assertInjectableTab(tab);

    const cookieOptionsPreview =
      currentStorageType === STORAGE_TYPES.cookie
        ? getCookieWriteOptions(oldCookieDetail, { applySideEffects: false })
        : null;

    let cookieIdentityChanged = false;
    if (oldCookieDetail && cookieOptionsPreview) {
      const oldPath = oldCookieDetail.path || '/';
      const oldDomainNorm = oldCookieDetail.hostOnly
        ? ''
        : String(oldCookieDetail.domain || '').replace(/^\./, '');
      const nextPath = cookieOptionsPreview.path || '/';
      const nextDomainNorm = (cookieOptionsPreview.domain || '').replace(/^\./, '');
      cookieIdentityChanged =
        oldCookieDetail.name !== key ||
        oldPath !== nextPath ||
        oldDomainNorm !== nextDomainNorm ||
        serializePartitionKeyPart(oldCookieDetail.partitionKey) !==
          serializePartitionKeyPart(cookieOptionsPreview.partitionKey);
    }

    /** @type {'replace-all-same-name' | 'upsert-identity'} */
    let cookieConflictMode = 'upsert-identity';

    if (isStorageRename) {
      const oldKey = row.originKey;
      const oldData = await readStorageValue(tab, currentStorageType, oldKey);
      const newData = await readStorageValue(tab, currentStorageType, key);
      let body = `将把「${oldKey}」重命名为「${key}」（先写入新 key，成功后再删除旧 key）。\n\n新值（${value.length} 字符）：\n${truncateText(value)}`;
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
        return false;
      }
    } else {
      const existingData = await readExistingForSave(tab, key, row);
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
        // Max-Age / 过期意图变更
        const oldExpireTip =
          oldCookie.session || !oldCookie.expirationDate
            ? '会话'
            : `过期至 ${new Date(oldCookie.expirationDate * 1000).toLocaleString()}`;
        let nextExpireTip = '会话';
        if (
          cookieOptionsPreview.maxAge !== null &&
          cookieOptionsPreview.maxAge !== undefined &&
          Number.isFinite(cookieOptionsPreview.maxAge)
        ) {
          nextExpireTip = `Max-Age=${cookieOptionsPreview.maxAge}秒`;
        } else if (
          cookieOptionsPreview.expirationDate !== null &&
          cookieOptionsPreview.expirationDate !== undefined &&
          Number.isFinite(cookieOptionsPreview.expirationDate)
        ) {
          nextExpireTip = `保持过期至 ${new Date(cookieOptionsPreview.expirationDate * 1000).toLocaleString()}`;
        }
        const oldExpireSig =
          oldCookie.session || !oldCookie.expirationDate
            ? 'session'
            : `abs:${Math.floor(oldCookie.expirationDate)}`;
        const nextExpireSig =
          cookieOptionsPreview.maxAge !== null && Number.isFinite(cookieOptionsPreview.maxAge)
            ? `max:${cookieOptionsPreview.maxAge}`
            : cookieOptionsPreview.expirationDate != null &&
                Number.isFinite(cookieOptionsPreview.expirationDate)
              ? `abs:${Math.floor(cookieOptionsPreview.expirationDate)}`
              : 'session';
        if (oldExpireSig !== nextExpireSig) {
          cookieAttrLines.push(`过期：${oldExpireTip} → ${nextExpireTip}`);
        }
      }

      if (cookieIdentityChanged && oldCookieDetail) {
        let body = `将写入「${key}」（path=${cookieOptionsPreview.path || '/'}），并删除旧条目「${oldCookieDetail.name}」（path=${oldCookieDetail.path || '/'}）。\n\n新值（${value.length} 字符）：\n${truncateText(value)}`;
        if (cookieAttrLines.length) {
          body += `\n\n属性变更：\n- ${cookieAttrLines.join('\n- ')}`;
        }
        if (existingData.cookie && existingData.value !== null) {
          body += `\n\n目标 identity 已存在，将被覆盖（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}`;
        }
        if (existingData.sameNameConflict) {
          body += `\n\n注意：另有 ${existingData.sameNameCount} 条同名 cookie（不同 Path/Domain/分区）会保留，不会一并删除。`;
        } else if (existingData.sameNameCount > 0) {
          body += `\n\n注意：另有 ${existingData.sameNameCount} 条同名 cookie（不同 Path/Domain/分区）会保留。`;
        }
        const confirmed = await showConfirmDialog({
          title: `确认迁移 Cookie「${oldCookieDetail.name}」？`,
          body,
          okText: '确认迁移',
          danger: true,
        });
        if (!confirmed) {
          setStatus('已取消保存', 'empty');
          return false;
        }
      } else if (existingData.sameNameConflict) {
        // 同名不同 Path：无论值是否碰巧相同，都要明确确认
        let body = `将写入「${key}」（path=${cookieOptionsPreview?.path || '/'}）。\n\n新值（${value.length} 字符）：\n${truncateText(value)}`;
        body += `\n\n注意：已存在 ${existingData.sameNameCount} 条同名 cookie（不同 Path/Domain/分区）。\n默认只新增/更新当前 identity，不会删除其它同名条目。`;
        if (cookieOptionsPreview) {
          body += `\n\n属性：HttpOnly=${cookieOptionsPreview.httpOnly ? '是' : '否'}，Secure=${cookieOptionsPreview.secure ? '是' : '否'}，Path=${cookieOptionsPreview.path || '/'}`;
        }
        const confirmedExact = await showConfirmDialog({
          title: `确认写入「${key}」？`,
          body: `${body}\n\n若需删除全部同名后再写入，请先用各自行的「删除」清掉其它 Path。`,
          okText: '仅更新当前',
          danger: true,
        });
        if (!confirmedExact) {
          setStatus('已取消保存', 'empty');
          return false;
        }
        cookieConflictMode = 'upsert-identity';
      } else if (existingData.value !== null && existingData.value !== value) {
        let body = `旧值（${existingData.value.length} 字符）：\n${truncateText(existingData.value)}\n\n新值（${value.length} 字符）：\n${truncateText(value)}`;
        if (cookieAttrLines.length) {
          body += `\n\n属性变更：\n- ${cookieAttrLines.join('\n- ')}`;
        }
        const confirmed = await showConfirmDialog({
          title: `确认覆盖写入「${key}」？`,
          body,
          okText: '确认覆盖',
          danger: true,
        });
        if (!confirmed) {
          setStatus('已取消保存', 'empty');
          return false;
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
          return false;
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
          return false;
        }
      }
    }

    setStatus(
      prepared.usedFallback
        ? '已回退格式化前原文并压缩，写入中...'
        : keptEditsOnWrite
          ? `已按编辑重序列化 ${prepared.restoredCount} 处并压缩，写入中...`
          : prepared.restoredCount > 0
            ? `已还原 ${prepared.restoredCount} 处并压缩，写入中...`
            : prepared.minified
              ? '已压缩，写入中...'
              : '写入中...'
    );

    const cookieOptions =
      currentStorageType === STORAGE_TYPES.cookie
        ? getCookieWriteOptions(oldCookieDetail)
        : undefined;

    // local/session 重命名：先写新 key，成功后再删旧 key，避免写失败丢数据
    const pageData = await writeStorageValue(
      tab,
      currentStorageType,
      key,
      value,
      cookieOptions,
      cookieConflictMode
    );

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
      // 软失败保留旧 identity，避免「属性/值不符却已删掉原 Cookie」
      if (cookieIdentityChanged && pageData.cookie) {
        failTip += '；新条目可能已写入，旧条目仍保留。请刷新后核对，必要时手动删除多余项。';
      }
      setStatus(failTip, 'error');
      await refreshAndRenderTable({
        preferActiveKey:
          currentStorageType === STORAGE_TYPES.cookie && pageData.cookie
            ? buildCookieCacheKey(pageData.cookie)
            : key,
      });
      return false;
    }

    if (isStorageRename && row.originKey) {
      const deleteResult = await deleteStorageValue(tab, currentStorageType, row.originKey);
      if (!deleteResult.success) {
        setStatus(
          `新 key「${key}」已写入，但旧 key「${row.originKey}」删除失败，请手动删除旧 key`,
          'error'
        );
        await refreshAndRenderTable({ preferActiveKey: key });
        return false;
      }
    }

    // Cookie 改名/改 Path/Domain：写入新 identity 成功后，删除旧 identity（含 partitionKey）
    // 属性未按预期时保留旧条目，避免「新属性不对却删掉原 Cookie」
    if (cookieIdentityChanged && oldCookieDetail && !pageData.attributeMismatch) {
      await chrome.cookies.remove({
        url: buildCookieUrl(oldCookieDetail, tab),
        name: oldCookieDetail.name,
        storeId: oldCookieDetail.storeId,
        ...buildPartitionKeyField(oldCookieDetail),
      });
      const oldCacheKey = buildCookieCacheKey(oldCookieDetail);
      const stillExists = (await collectTabCookies(tab)).some(
        (cookie) => buildCookieCacheKey(cookie) === oldCacheKey
      );
      if (stillExists) {
        setStatus(
          `新 Cookie「${key}」已写入，但旧条目「${oldCookieDetail.name}」删除失败，请手动删除`,
          'error'
        );
        await refreshAndRenderTable({
          preferActiveKey: pageData.cookie
            ? buildCookieCacheKey(pageData.cookie)
            : key,
        });
        return false;
      }
    }

    clearFormatStateForUi();
    if (textarea) {
      textarea.value = pageData.value ?? value;
      syncRowModelFromDom(rowId);
    } else {
      row.value = pageData.value ?? value;
    }
    await pushKeyHistory(key);

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

    let valueNormTip = '';
    if (currentStorageType === STORAGE_TYPES.cookie && pageData.valueMismatched) {
      valueNormTip = '；浏览器返回值与写入值略有差异（已按回读结果展示）';
    }
    let attrMismatchTip = '';
    if (currentStorageType === STORAGE_TYPES.cookie && pageData.attributeMismatch) {
      attrMismatchTip = `；${pageData.error || '部分属性未按预期生效'}`;
      if (cookieIdentityChanged) {
        attrMismatchTip += '；旧条目已保留，请刷新后核对';
      }
    }

    const statusTone = pageData.attributeMismatch ? 'error' : 'success';
    setStatus(
      `写入成功：${getStorageTypeLabel(currentStorageType)} / ${key}（长度 ${value.length}）${cookieTip}${prepareTip}${valueNormTip}${attrMismatchTip}`,
      statusTone
    );

    await refreshAndRenderTable({
      preferActiveKey:
        currentStorageType === STORAGE_TYPES.cookie && pageData.cookie
          ? buildCookieCacheKey(pageData.cookie)
          : key,
    });
    return true;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '写入失败', 'error');
    return false;
  } finally {
    if (ownedBusy) {
      setBusy(false);
    }
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
  setBusy(true);

  try {
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
        void setActiveRow(activeRowId, { skipAttrConfirm: true });
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
      // 用缓存详情构造删除选项，确认前不回写属性栏，避免取消删除时冲掉未保存属性
      cookieOptions = {
        path: cookie?.path || '/',
        domain: cookie?.hostOnly ? '' : cookie?.domain || '',
        partitionKey: cookie?.partitionKey,
      };
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

    setStatus('删除中...');

    const pageData = await deleteStorageValue(tab, currentStorageType, key, cookieOptions);

    if (!pageData.success) {
      const failTip =
        currentStorageType === STORAGE_TYPES.cookie
          ? '删除失败：未删掉匹配的 cookie。请核对该行 Path/Domain/分区徽章后重试'
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
  const canDiscard = await confirmDiscardDirtyEdits('导出');
  if (!canDiscard) {
    setStatus('已取消导出', 'empty');
    setBusy(false);
    return;
  }

  setStatus('导出中...');

  try {
    const pageData = await refreshAndRenderTable({ keepDrafts: false });
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

  setBusy(true);
  const canDiscard = await confirmDiscardDirtyEdits('导入');
  if (!canDiscard) {
    setStatus('已取消导入', 'empty');
    setBusy(false);
    importFileInput.value = '';
    return;
  }

  // 丢弃确认通过后保持持锁，覆盖后续解析与二次确认间隙
  setStatus('导入准备中...');
  let importTargetType = currentStorageType;
  let switchedToCookieForImport = false;

  /**
   * 业务校验失败：提示并视情况回刷（避免同函数 throw 再被 catch）
   * @param {string} message
   */
  const abortImportWithError = async (message) => {
    setStatus(message, 'error');
    if (switchedToCookieForImport) {
      try {
        await refreshAndRenderTable();
      } catch {
        // 刷新失败时至少保持错误提示
      }
    }
  };

  try {
    const text = await file.text();
    let payload = parseImportPayload(text);

    // cookies[] 只能进 cookie：非 cookie tab 时询问是否切换
    if (payload.mode === 'cookieDetails' && importTargetType !== STORAGE_TYPES.cookie) {
      const switchToCookie = await showConfirmDialog({
        title: '需要切换到 cookie',
        body: '文件包含 cookies[] 详情，只能导入到 cookie 类型。是否切换到 cookie 并继续导入？',
        okText: '切换并导入',
        danger: false,
      });
      if (!switchToCookie) {
        setStatus('已取消导入', 'empty');
        return;
      }
      currentStorageType = STORAGE_TYPES.cookie;
      importTargetType = STORAGE_TYPES.cookie;
      switchedToCookieForImport = true;
      renderActiveTab();
      pageKeyCache = [];
      pageEntriesCache = {};
      cookieDetailCache = {};
      tableRows = [];
      activeRowId = null;
      await chrome.storage.local.set({ [LAST_TYPE_STORAGE]: STORAGE_TYPES.cookie });
      await restoreDefaultFilterKeyword();
    }

    /** @type {string[]} */
    let skippedEmpty = [];
    if (payload.mode === 'entries') {
      const stripped = omitEmptyEntryValues(payload.entries);
      payload = { ...payload, entries: stripped.entries };
      skippedEmpty = stripped.skipped;
      if (!Object.keys(payload.entries).length) {
        await abortImportWithError(
          skippedEmpty.length
            ? `${formatEmptyValueKeysTip(skippedEmpty)}；文件中没有其它可导入条目`
            : '导入内容为空'
        );
        return;
      }
    } else if (payload.mode === 'cookieDetails') {
      const stripped = omitEmptyCookieValues(payload.cookies);
      payload = { ...payload, cookies: stripped.cookies };
      skippedEmpty = stripped.skipped;
      if (!payload.cookies.length) {
        await abortImportWithError(
          skippedEmpty.length
            ? `${formatEmptyValueKeysTip(skippedEmpty)}；文件中没有其它可导入条目`
            : '导入 cookies 详情为空'
        );
        return;
      }
    }

    if (payload.type && payload.type !== importTargetType) {
      const confirmedType = await showConfirmDialog({
        title: '导入类型不一致',
        body: `文件类型是「${payload.type}」，当前是「${importTargetType}」。仍要导入到当前类型吗？`,
        okText: '继续导入',
        danger: true,
      });
      if (!confirmedType) {
        setStatus('已取消导入', 'empty');
        if (switchedToCookieForImport) {
          await refreshAndRenderTable();
        }
        return;
      }
    }

    if (currentStorageType !== importTargetType) {
      await abortImportWithError('导入期间存储类型已变化，已取消');
      return;
    }

    let preview;
    let totalCount;
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
    const skipTip = skippedEmpty.length
      ? `\n\n将跳过 ${skippedEmpty.length} 个空值（清空请用删除）。`
      : '';

    const confirmed = await showConfirmDialog({
      title: `确认导入到 ${getStorageTypeLabel(importTargetType)}？`,
      body: `将写入 / 覆盖以下条目：\n${preview}${moreTip}${skipTip}`,
      okText: '确认导入',
      danger: true,
    });
    if (!confirmed) {
      setStatus('已取消导入', 'empty');
      if (switchedToCookieForImport) {
        await refreshAndRenderTable();
      }
      return;
    }

    if (currentStorageType !== importTargetType) {
      await abortImportWithError('导入期间存储类型已变化，已取消');
      return;
    }

    setStatus('导入中...');

    const tab = await getActiveTab();
    assertInjectableTab(tab);

    let result;
    if (importTargetType === STORAGE_TYPES.cookie && payload.mode === 'cookieDetails') {
      result = await writeCookiesDetailedBatchViaApi(tab, payload.cookies);
    } else if (importTargetType === STORAGE_TYPES.cookie) {
      const cookieOptions = getCookieWriteOptions(null, { applySideEffects: false });
      result = await writeCookiesBatchViaApi(tab, payload.entries, cookieOptions);
    } else if (payload.mode === 'entries') {
      result = await executeInTab(tab.id, writePageStorageBatch, [
        importTargetType,
        payload.entries,
        null,
      ]);
    } else {
      await abortImportWithError('当前类型不支持 cookies 详情导入，请切换到 cookie');
      return;
    }

    await refreshAndRenderTable();

    const skipSuffix = skippedEmpty.length ? `，跳过空值 ${skippedEmpty.length}` : '';
    if (result.failCount > 0) {
      setStatus(
        `导入完成：成功 ${result.successCount}，失败 ${result.failCount}${skipSuffix}`,
        'error'
      );
    } else {
      setStatus(`导入成功：${result.successCount} 条${skipSuffix}`, 'success');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导入失败', 'error');
    if (switchedToCookieForImport) {
      try {
        await refreshAndRenderTable();
      } catch {
        // 刷新失败时至少保持错误提示
      }
    }
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

  setBusy(true);
  const canDiscard = await confirmDiscardDirtyEdits('切换类型');
  if (!canDiscard) {
    setStatus('已取消切换', 'empty');
    setBusy(false);
    return;
  }

  setStatus('切换中...');
  try {
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

    await restoreDefaultFilterKeyword();
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
  const canDiscard = await confirmDiscardDirtyEdits('刷新');
  if (!canDiscard) {
    setStatus('已取消刷新', 'empty');
    setBusy(false);
    return;
  }
  setStatus('刷新中...');
  try {
    await refreshAndRenderTable({ keepDrafts: false });
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

  setBusy(true);
  try {
    const typeLabel = getStorageTypeLabel(currentStorageType);
    const dirtyRows = collectDirtyRows();
    // 用当前缓存/表格计数，确认前不刷新，避免「取消清空仍丢编辑」
    const storedRows = tableRows.filter((row) => !row.isDraft);
    let count = Math.max(pageKeyCache.length, storedRows.length);

    if (!count) {
      setStatus(`当前 ${typeLabel} 已为空`, 'empty');
      return;
    }

    const previewSource =
      currentStorageType === STORAGE_TYPES.cookie && pageKeyCache.length
        ? pageKeyCache
        : storedRows.map((row) =>
            currentStorageType === STORAGE_TYPES.cookie
              ? row.cacheKey || row.originKey || row.key
              : row.originKey || row.key
          );

    const previewKeys = previewSource.slice(0, 8).map((key) => {
      if (currentStorageType === STORAGE_TYPES.cookie) {
        const detail = cookieDetailCache[key];
        const name = detail?.name || key;
        const path = detail?.path || '/';
        return `- ${name} (path=${path})`;
      }
      return `- ${key}`;
    });
    const moreTip = count > 8 ? `\n…共 ${count} 条` : '';
    const dirtyTip = dirtyRows.length
      ? `\n\n当前有 ${dirtyRows.length} 处未保存编辑/草稿，清空时将一并丢弃。`
      : '';
    const cookieTip =
      currentStorageType === STORAGE_TYPES.cookie
        ? '\n\n将按每条 Cookie 的 Path/Domain/分区精确删除（含 HttpOnly）。'
        : '\n\n将调用 clear() 清空当前源下全部条目。';

    const confirmed = await showConfirmDialog({
      title: `确认清空全部 ${typeLabel}？`,
      body: `此操作不可恢复，将删除：\n${previewKeys.join('\n')}${moreTip}${dirtyTip}${cookieTip}`,
      okText: '确认清空',
      danger: true,
    });
    if (!confirmed) {
      setStatus('已取消清空', 'empty');
      return;
    }

    setStatus('清空中...');
    const tab = await getActiveTab();
    assertInjectableTab(tab);

    if (currentStorageType === STORAGE_TYPES.cookie) {
      const result = await clearAllCookiesViaApi(tab);
      clearFormatStateForUi();
      await refreshAndRenderTable({ keepDrafts: false });
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
    await refreshAndRenderTable({ keepDrafts: false });
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
async function handleTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const actionBtn = target.closest('[data-action]');
  const action = actionBtn instanceof HTMLElement ? actionBtn.dataset.action : '';
  // 复制为只读，busy 时仍允许
  if (isBusy && action !== 'copy') {
    return;
  }

  const tr = target.closest('tr[data-row-id]');
  if (!(tr instanceof HTMLTableRowElement) || !tr.dataset.rowId) {
    return;
  }
  const rowId = tr.dataset.rowId;

  // 点击行设为 active
  if (rowId !== activeRowId && !isBusy) {
    const switched = await setActiveRow(rowId);
    if (!switched) {
      return;
    }
  }

  if (!(actionBtn instanceof HTMLElement) || !action) {
    return;
  }

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
  if (isBusy) {
    return;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const tr = target.closest('tr[data-row-id]');
  if (!(tr instanceof HTMLTableRowElement) || !tr.dataset.rowId) {
    return;
  }
  const nextRowId = tr.dataset.rowId;
  if (nextRowId === activeRowId) {
    return;
  }
  void (async () => {
    const previousId = activeRowId;
    const switched = await setActiveRow(nextRowId);
    if (!switched && previousId) {
      // 取消切换：尽量把焦点拉回原行
      const keyInput = getRowKeyInput(previousId);
      const valueInput = getRowValueTextarea(previousId);
      (keyInput || valueInput)?.focus();
    }
  })();
}

/**
 * 行内输入：同步模型；格式化展开后标记 dirty；刷新未保存徽章
 * @param {Event} event
 */
function handleTableInput(event) {
  if (isBusy) {
    return;
  }
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

  refreshRowDirtyIndicator(rowId);
}

/**
 * 仅更新某行的未保存样式与徽章（避免整表重绘丢焦点）
 * @param {string} rowId
 */
function refreshRowDirtyIndicator(rowId) {
  const row = tableRows.find((item) => item.rowId === rowId);
  const tr = storageTableBody.querySelector(`tr[data-row-id="${CSS.escape(rowId)}"]`);
  if (!row || !(tr instanceof HTMLTableRowElement)) {
    return;
  }
  const dirty = isRowDirty(row);
  tr.classList.toggle('is-dirty', dirty && !row.isDraft);

  const wrap = tr.querySelector('.row-key-wrap');
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  let badgesEl = wrap.querySelector('.row-badges');
  let dirtyBadge = wrap.querySelector('.row-badge.is-dirty');

  if (dirty && !row.isDraft) {
    if (!(badgesEl instanceof HTMLElement)) {
      badgesEl = document.createElement('div');
      badgesEl.className = 'row-badges';
      wrap.appendChild(badgesEl);
    }
    if (!(dirtyBadge instanceof HTMLElement)) {
      dirtyBadge = document.createElement('span');
      dirtyBadge.className = 'row-badge is-dirty';
      dirtyBadge.title = '尚未保存到页面';
      dirtyBadge.textContent = '未保存';
      badgesEl.appendChild(dirtyBadge);
    }
  } else if (dirtyBadge instanceof HTMLElement) {
    dirtyBadge.remove();
    if (badgesEl instanceof HTMLElement && !badgesEl.childElementCount) {
      badgesEl.remove();
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
    syncFilterClearButton();
    void applyKeysFilterKeyword(keysFilterInput.value, {
      pushHistory: false,
      closeDropdown: false,
    });
    openFilterDropdown();
  });
  // 悬停即展开（输入框已聚焦时 focus 不会再触发）
  if (keysFilterWrap instanceof HTMLElement) {
    keysFilterWrap.addEventListener('mouseenter', () => {
      openFilterDropdown();
    });
    keysFilterWrap.addEventListener('mouseleave', () => {
      if (document.activeElement === keysFilterInput) {
        return;
      }
      scheduleFilterDropdownClose(120);
    });
  }
  keysFilterInput.addEventListener('focus', () => {
    openFilterDropdown();
  });
  // 已聚焦时再次点击也要能打开（Esc / 选中后收起的场景）
  keysFilterInput.addEventListener('mousedown', () => {
    openFilterDropdown();
  });
  keysFilterInput.addEventListener('click', () => {
    openFilterDropdown();
  });
  keysFilterInput.addEventListener('blur', () => {
    // 历史仅在 Enter / 选中建议时写入，避免半截输入污染「最近筛选」
    scheduleFilterDropdownClose(150);
  });
  keysFilterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (filterDropdownOpen) {
        event.preventDefault();
        closeFilterDropdown();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!filterDropdownOpen) {
        openFilterDropdown();
      }
      if (!filterDropdownFlatOptions.length) {
        return;
      }
      filterDropdownActiveIndex =
        filterDropdownActiveIndex < 0
          ? 0
          : (filterDropdownActiveIndex + 1) % filterDropdownFlatOptions.length;
      syncFilterDropdownActiveOption();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filterDropdownOpen) {
        openFilterDropdown();
      }
      if (!filterDropdownFlatOptions.length) {
        return;
      }
      filterDropdownActiveIndex =
        filterDropdownActiveIndex < 0
          ? filterDropdownFlatOptions.length - 1
          : (filterDropdownActiveIndex - 1 + filterDropdownFlatOptions.length) %
            filterDropdownFlatOptions.length;
      syncFilterDropdownActiveOption();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (filterDropdownOpen && filterDropdownActiveIndex >= 0) {
        const active = filterDropdownFlatOptions[filterDropdownActiveIndex];
        if (active) {
          selectFilterSuggestion(active.value);
        }
        return;
      }
      void applyKeysFilterKeyword(keysFilterInput.value, {
        pushHistory: true,
        closeDropdown: true,
      });
    }
  });
  if (keysFilterDropdown instanceof HTMLElement) {
    keysFilterDropdown.addEventListener('mousedown', (event) => {
      // 避免点选项时 input blur 抢先关闭
      event.preventDefault();
      cancelFilterDropdownClose();
    });
    keysFilterDropdown.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const option = target.closest('.keys-filter-option');
      if (!(option instanceof HTMLElement)) {
        return;
      }
      const index = Number(option.dataset.index);
      const selected = filterDropdownFlatOptions[index];
      if (selected) {
        selectFilterSuggestion(selected.value);
      }
    });
  }
  if (keysFilterClearBtn instanceof HTMLButtonElement) {
    keysFilterClearBtn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      cancelFilterDropdownClose();
    });
    keysFilterClearBtn.addEventListener('click', () => {
      if (isBusy) {
        return;
      }
      clearKeysFilter();
    });
  }
  document.addEventListener('mousedown', (event) => {
    if (!filterDropdownOpen || !(keysFilterWrap instanceof HTMLElement)) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && keysFilterWrap.contains(target)) {
      return;
    }
    closeFilterDropdown();
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
  if (jsonCloseBtn instanceof HTMLButtonElement) {
    jsonCloseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      void handleJsonDialogCloseRequest();
    });
  }
  jsonDialog.addEventListener('cancel', (event) => {
    // Esc：拦截默认关闭，走同一套未保存确认
    event.preventDefault();
    void handleJsonDialogCloseRequest();
  });
  jsonDialog.addEventListener('close', () => {
    jsonDialogRowId = null;
    jsonDialogMode = 'view';
    jsonDialogScope = 'row';
    // 关闭弹窗时清掉格式化态，避免污染后续行内保存
    clearFormatStateForUi();
    clearJsonDialogToast();
  });
  // 点击遮罩（dialog 空白区）关闭
  jsonDialog.addEventListener('click', (event) => {
    if (event.target === jsonDialog) {
      void handleJsonDialogBackdropClose();
    }
  });
  confirmDialog.addEventListener('click', (event) => {
    if (event.target === confirmDialog) {
      confirmDialog.close('cancel');
    }
  });
  jsonDialogEditor.addEventListener('input', () => {
    if (jsonDialogMode !== 'edit') {
      return;
    }
    const formatTargetId = getJsonDialogFormatTargetId();
    if (formatBoundRowId && formatTargetId && formatBoundRowId === formatTargetId && formatExpandActive) {
      formatExpandDirty = true;
    }
    let isJson;
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
  if (cookieMakeSessionBtn instanceof HTMLButtonElement) {
    cookieMakeSessionBtn.addEventListener('click', () => {
      cookieMaxAgeInput.value = '';
      clearCookiePreservedExpiration();
      cookieMaxAgeInput.placeholder = '秒，空=会话';
      cookieMaxAgeInput.title = '已设为会话 Cookie：保存后将去掉绝对过期时间';
      if (currentStorageType === STORAGE_TYPES.cookie) {
        setStatus('已标记为会话 Cookie，请点击对应行的「保存」写入', 'empty');
      }
    });
  }
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
    await restoreDefaultFilterKeyword();
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

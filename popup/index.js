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

/** @type {string} */
let currentStorageType = DEFAULT_STORAGE_TYPE;
/** 读写/删除互斥锁 */
let isBusy = false;

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
 * 注意：此函数会被注入页面，内部逻辑需自包含
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

  /**
   * 从 document.cookie 解析指定 key
   * @param {string} cookieKeyName
   * @returns {string | null}
   */
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

  /**
   * 从 document.cookie 解析指定 key
   * @param {string} cookieKeyName
   * @returns {string | null}
   */
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
  // SameSite=None 时浏览器要求 Secure
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
  const success = readValue === value;

  return {
    ...routeInfo,
    value: readValue,
    success,
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

  /**
   * 从 document.cookie 解析指定 key
   * @param {string} cookieKeyName
   * @returns {string | null}
   */
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

  const blockedPrefix = BLOCKED_URL_PREFIXES.find((prefix) => tab.url.startsWith(prefix));
  if (blockedPrefix) {
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
 * 设置状态文案
 * @param {string} text
 * @param {'success' | 'error' | 'empty' | ''} type
 */
function setStatus(text, type = '') {
  statusTextEl.textContent = text;
  statusTextEl.className = `status${type ? ` is-${type}` : ''}`;
}

/**
 * 获取存储类型展示名（与 Web API / Tab 文案保持一致）
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

  // 超出两行时开启滚动，并固定显示滚动条提示可滚动
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

  // 兼容旧数据：仅有 last-key 时补进历史
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
  });
  updateKeyPlaceholder();
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

  const historyList = await loadAndRenderKeyHistory();
  storageKeyInput.value = historyList[0] || '';
  syncClearKeyButton();
  await chrome.storage.local.set({ [LAST_TYPE_STORAGE]: storageType });

  if (storageKeyInput.value.trim()) {
    await handleRead();
  } else {
    const lastValueField = getLastValueField(storageType);
    const stored = await chrome.storage.local.get(lastValueField);
    valueInput.value = typeof stored[lastValueField] === 'string' ? stored[lastValueField] : '';
    autoResizeValueInput();
    setStatus('请输入 key 后读取', '');
  }
}

/**
 * 点击历史记录填充并读取
 * @param {string} key
 */
async function handleSelectHistoryKey(key) {
  if (isBusy) {
    return;
  }
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
      const tip =
        currentStorageType === STORAGE_TYPES.cookie
          ? `cookie "${key}" 不存在（HttpOnly cookie 无法通过脚本读取）`
          : `key "${key}" 不存在`;
      setStatus(tip, 'empty');
    } else {
      valueInput.value = pageData.value;
      autoResizeValueInput();
      await saveLastValue(pageData.value);
      setStatus(`读取成功（${getStorageTypeLabel(currentStorageType)}），长度 ${pageData.value.length}`, 'success');
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

  setBusy(true);
  setStatus('写入中...');

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

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
  const confirmed = window.confirm(`确认删除 ${typeLabel} 中的 key「${key}」？此操作不可撤销。`);
  if (!confirmed) {
    return;
  }

  setBusy(true);
  setStatus('删除中...');

  try {
    const tab = await getActiveTab();
    assertInjectableTab(tab);

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
          ? '删除失败：cookie 仍存在（path/domain 可能不匹配，或为 HttpOnly）'
          : '删除失败：key 仍存在';
      setStatus(failTip, 'error');
      return;
    }

    valueInput.value = '';
    autoResizeValueInput();
    await pushKeyHistory(key);
    await saveLastValue('');
    setStatus(`已删除：${typeLabel} / ${key}`, 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '删除失败', 'error');
  } finally {
    setBusy(false);
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
 * 设置弹窗最大高度（内容自适应，超出后滚动）
 * 说明：插件 popup 内 vh 无效，按屏幕可用高度 80% 计算，并受 Chrome 上限约束
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

  // 迁移旧版共用 last-value 到当前类型字段
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
  // 默认取当前类型历史最新一条；无历史则留空显示 placeholder
  storageKeyInput.value = historyList[0] || '';
  syncClearKeyButton();

  if (typeof stored[currentLastValueField] === 'string' && stored[currentLastValueField] && storageKeyInput.value) {
    valueInput.value = stored[currentLastValueField];
  }
  autoResizeValueInput();

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

  clearHistoryBtn.addEventListener('click', clearAllKeyHistory);

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
  valueInput.addEventListener('input', autoResizeValueInput);

  cookieSameSiteSelect.addEventListener('change', () => {
    if (cookieSameSiteSelect.value === 'None') {
      cookieSecureCheckbox.checked = true;
    }
  });

  storageKeyInput.addEventListener('input', syncClearKeyButton);
  storageKeyInput.addEventListener('keydown', (event) => {
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

  // 有历史 key 时默认读取；无历史则留空展示 placeholder
  if (storageKeyInput.value.trim()) {
    await handleRead();
  }
}

initPopup();

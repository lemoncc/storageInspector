# 应用存储管理

Chrome Manifest V3 浏览器扩展，用于管理当前页面的 **localStorage**、**sessionStorage** 与 **Cookie**（含 HttpOnly）。

当前版本：`2.0.9`

## 界面预览

![应用存储管理弹窗截图](./docs/screenshot.png)

## 安装（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本仓库根目录（包含 `manifest.json` 的目录）

修改代码后，在扩展管理页点击「重新加载」即可生效。若变更了权限（如剪贴板），必须重新加载扩展。

## 功能落位

| 区域 | 功能 |
|------|------|
| 顶栏 | 筛选 Key/值；刷新；JSON 查看 / JSON 编辑；导出 / 导入；清空 |
| Tabs | localStorage / sessionStorage / cookie（记住上次类型；方向键可切换） |
| Cookie 属性栏 | Path、Max-Age、Domain、SameSite、Secure、HttpOnly（随**当前选中行**；全局一份） |
| 主表格 | Key / 值可直接改；行内：编辑、复制、粘贴、保存、删除；草稿 / 未保存 / Cookie 徽章 |
| 表底 | 「+ 增加」草稿行；状态提示（可换行） |
| JSON 弹窗（单行） | 格式化 / 压缩 / 复制 / 粘贴 / 清空 / 保存 / 删除 |
| JSON 弹窗（全部） | local/session：`{ key: value }`；Cookie：`cookies[]` 详情数组 |

## 分类型说明

### localStorage / sessionStorage

- 打开弹窗自动拉取当前源下全部条目
- 改 Key 后保存按**重命名**（先写新 key，成功后再删旧 key）
- 合法 JSON 在保存时会自动压缩为一行
- **单行保存拒绝空字符串**；清空请用「删除」或工具栏「清空」

### Cookie

- 通过 `chrome.cookies` API 读写，支持 **HttpOnly**
- 行上徽章表示**已写入**结果：Path / Domain / HttpOnly / Secure / **分区**（有 `partitionKey` 时）
- 属性栏改完后，必须点该行「保存」才会生效；切到其它行会用该行缓存覆盖属性栏
- Max-Age 留空：会话 cookie；若刚读过带过期的条目，则表示「保持原过期」
- `__Host-` / `__Secure-` 前缀会按规范强制 Secure（`__Host-` 还会强制 Path=/、无 Domain）
- **删除 / 保存**：按 Path + Domain + 分区 **精确**匹配；其它同名 Path 默认保留
- 改 Key 或改 Path/Domain：写入新 identity 后会尝试删除旧条目
- **全部 JSON**：`[{ name, value, path, domain, partitionKey, ... }]`，同名多 Path 不合并；仍兼容 `{ name: value }`（按属性栏写一条，无法表达多 Path）

## 未保存与确认策略

| 操作 | 行为 |
|------|------|
| 切换 Tab / 刷新 / 导出 / 清空 | 若有未保存 Key/值或草稿，先确认是否丢弃 |
| 清空 | 丢弃确认通过后，再刷新核对数量，再确认清空 |
| 行上「未保存」徽章 | 只跟踪 Key/值相对上次加载的变化；**不含**属性栏改动 |
| 仅改 Cookie 属性栏 | 无徽章；切行会丢失未保存属性，请先点该行「保存」 |

写入 / 确认进行中会禁用主要按钮与类型切换，避免重复提交。

## 导入 / 导出

导出为 JSON v2，示例：

```json
{
  "type": "localStorage",
  "version": 2,
  "exportedAt": "2026-07-22T00:00:00.000Z",
  "origin": "https://example.com",
  "data": {
    "token": "{\"a\":1}"
  }
}
```

Cookie 导出额外带 `cookies[]`（path / domain / httpOnly / partitionKey 等）。导入时：

- `{ cookies: [...] }`：按每条自身属性写入（同 Path+Domain+分区才替换）
- `{ data: { key: value } }` 或纯 `{ key: value }`：写入当前类型；Cookie 则用属性栏批量写
- **空字符串值会被跳过**（不会整份失败）；单行保存仍拒绝空串
- 类型与当前 Tab 不一致时二次确认

## 全部 JSON

- 「写入全部」只覆盖 JSON 中出现的条目，**不会删除未出现的项**
- 编辑器清空为 `{}` / `[]` **不等于**清空存储；清空请用工具栏「清空」或逐条删除
- Cookie 推荐用详情数组；`{ name: value }` 仅为兼容模式

## 使用提示

- 系统页（`chrome://`）、扩展页、应用商店页通常无法读写；Cookie 还需 http(s) 主机权限
- 首次访问某站 Cookie 时，浏览器可能弹出网站访问权限请求
- 剪贴板相关能力变更后，需在扩展管理页「重新加载」
- 筛选：按 Key 或值；Cookie 还可匹配 Path / Domain；草稿行始终显示
- 站点若持续通过 `Set-Cookie` 重写 Cookie，保存后刷新仍可能被改回

## 已知限制

- Cookie 属性栏与行「未保存」不同步；切行会覆盖未保存属性
- `{ name: value }` 兼容模式无法管理同名多 Path；请用 `cookies[]` 或表格
- 页面上已存在的空值条目：导入 / 全部 JSON 会跳过空值，不会用空串覆盖或删除
- 分区 Cookie（CHIPS）依赖浏览器 API；极旧环境可能缺少 `partitionKey`
- `popup/index.js` 体量较大，尚未拆模块

## 目录结构

```text
.
├── manifest.json
├── icons/
├── docs/
│   └── screenshot.png
├── popup/
│   ├── index.html
│   ├── index.css
│   └── index.js
├── LICENSE
└── README.md
```

## 权限说明

| 权限 | 用途 |
|------|------|
| `activeTab` / `scripting` | 在当前页读写 localStorage / sessionStorage |
| `cookies` | 读写 Cookie（含 HttpOnly） |
| `storage` | 保存最近类型、历史 Key 等扩展本地状态 |
| `clipboardRead` / `clipboardWrite` | 复制 / 粘贴 |
| 主机权限 `http(s)://*/*` | 访问各站点 Cookie |

## License

[MIT](./LICENSE)

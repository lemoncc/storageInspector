# 应用存储管理

Chrome Manifest V3 浏览器扩展，用于管理当前页面的 **localStorage**、**sessionStorage** 与 **Cookie**（含 HttpOnly）。

当前版本：`2.1.2`

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
| 顶栏 | 筛选 Key/值（下拉：最近 5 次筛选历史 + 当前表全部 key；默认上次筛选）；刷新；JSON 查看 / JSON 编辑；导出 / 导入；清空 |
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

- 通过 `chrome.cookies` API 读写，支持 **HttpOnly** 与 **分区 Cookie（CHIPS）**
- 列表使用 `partitionKey: {}` 同时拉取未分区与分区罐
- 行上徽章：Path / Domain / HttpOnly / Secure / **分区**
- 属性栏改完后须点该行「保存」；切到其它行若属性未保存会提示确认
- Max-Age / 过期变更会进入保存确认摘要
- 同 identity 更新：**先 `set` 覆盖，成功后再按需删其它同名**（避免先删后写丢数据）
- 改 Key 或改 Path/Domain：写入新 identity 后删除旧条目
- **全部 JSON**：`cookies[]` 详情数组；`{}` / `[]` ≠ 清空存储

## 未保存与确认策略

| 操作 | 行为 |
|------|------|
| 切换 Tab / 刷新 / 导出 / 导入 | 若有未保存 Key/值或草稿，先确认是否丢弃 |
| 清空 | **单次确认**（可含未保存提示）；确认前不刷新，取消可保留编辑 |
| 切 Cookie 行 | 属性栏相对已写入结果有改动时，切换前提示 |
| 行上「未保存」徽章 | 只跟踪 Key/值；属性栏另有切行确认 |

## 导入 / 导出

导出为 JSON v2；Cookie 额外带 `cookies[]`。导入时：

- `{ cookies: [...] }`：按条自身属性精确写入
- `{ data }` / 纯对象：按当前类型写入；Cookie 用属性栏
- 空字符串值会跳过；类型不一致二次确认

## 使用提示

- 系统页、扩展页、应用商店页（含 `chromewebstore.google.com`）通常无法读写
- 筛选：Key 或值；Cookie 还可匹配 Path / Domain
- 站点若持续 `Set-Cookie` 重写，保存后刷新仍可能被改回

## 已知限制

- `{ name: value }` 兼容模式无法管理同名多 Path；请用 `cookies[]` 或表格
- UI 无法新建分区 Cookie（可编辑/导入已有分区条目）
- 页面已存在的空值：导入 / 全部 JSON 会跳过，不会用空串删除
- 极旧 Chrome 可能不支持 `partitionKey`（会自动回退）
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
| `activeTab` / `scripting` | 读写 localStorage / sessionStorage |
| `cookies` | 读写 Cookie（含 HttpOnly / 分区） |
| `storage` | 扩展本地状态 |
| `clipboardRead` / `clipboardWrite` | 复制 / 粘贴 |
| 主机权限 `http(s)://*/*` | 访问各站点 Cookie |

## License

[MIT](./LICENSE)

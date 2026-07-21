# 应用存储管理

Chrome Manifest V3 浏览器扩展，用于管理当前页面的 **localStorage**、**sessionStorage** 与 **Cookie**（含 HttpOnly）。

当前版本：`1.7.7`

## 功能

- 按 Key **读取 / 写入 / 删除** localStorage、sessionStorage、Cookie
- Cookie 支持 Path、Domain、Max-Age、SameSite、Secure、**HttpOnly**
- **历史记录**与 Key **联想**
- **全部 Key** 浏览、筛选、刷新
- **导入 / 导出** JSON（Cookie 可带完整属性）
- 值区支持递归格式化、压缩、复制、粘贴

## 安装（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本仓库根目录（包含 `manifest.json` 的目录）

修改代码后，在扩展管理页点击「重新加载」即可生效。若变更了权限（如剪贴板），必须重新加载扩展。

## 目录结构

```text
.
├── manifest.json      # 扩展清单
├── icons/             # 扩展图标
├── popup/             # 弹窗 UI
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
| `storage` | 保存历史 Key、最近类型等扩展本地状态 |
| `clipboardRead` / `clipboardWrite` | 弹窗内复制 / 粘贴按钮 |
| 主机权限 `http(s)://*/*` | 访问各站点 Cookie |

## 使用提示

- 系统页（如 `chrome://`）、扩展页、应用商店页不支持读写
- Cookie 同名多 Path 时，建议从「全部 Key」点选后再删，以确保 Path / Domain 匹配
- 写入空字符串会被拒绝，清空请使用「删除」
- 快捷键：Key 输入框 `Enter` 读取；`Cmd/Ctrl + Enter` 写入

## License

[MIT](./LICENSE)

# config 目录说明

## 定位

`config` 是项目的可读运行配置目录，只放非密钥、可人工审阅、可随代码提交的配置资源。

## 文件职责

| 文件 | 职责 | 修改时机 |
| --- | --- | --- |
| `default.config.json` | 默认轮询、浏览器、日志、数据库和合规配置 | 调整项目默认运行行为时修改 |
| `i18n.json` | 页面 URL、标题和正文关键词识别规则 | 页面文案或 URL 变化时修改 |
| `selectors.json` | 浏览器自动化使用的 CSS 选择器 | 页面 DOM 结构变化时修改 |

## 边界

- 密钥、账号、邮箱密码、短信服务 token 只写入 `.env`。
- 数据库、日志、导出的凭证 JSON 只写入 `data`。
- `src/config` 负责 schema、loader 和常量，根目录 `config` 负责运行时 JSON 资源。

## 验证

修改本目录后至少执行：

```powershell
pnpm typecheck
.\node_modules\.bin\vitest.cmd run tests/unit/configLoader.test.ts tests/unit/pageDetector.test.ts
```
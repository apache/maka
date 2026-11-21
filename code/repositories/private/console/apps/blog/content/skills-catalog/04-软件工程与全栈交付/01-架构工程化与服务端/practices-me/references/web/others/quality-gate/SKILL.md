---
name: quality-me
description: 改后质量门禁与提交前只读检查。Use after editing JavaScript, TypeScript, React, Taro, SCSS, CSS Modules, JSON, Markdown docs, or skill files, or before commit / pre-commit review when Codex must verify formatting, import order, Stylelint, ESLint, Prettier, touched-file scope, relevant tests, UTF-8 readability, git diff risk, debug residue, or final reporting accuracy.
---

# Project Quality Gate

## 使用定位

用于改动后的收尾验证。目标是避免格式、导入排序、样式诊断、测试和文档可读性遗漏。

## 先识别改动范围

1. 列出本轮 touched files。
2. 区分本轮改动和用户已有改动。
3. 优先使用项目已有脚本。
4. dirty tree 中只格式化本轮 touched files。
5. 命令失败时报告真实错误，不声称通过。

## 提交前只读检查

当用户准备提交、要求提交前检查、commit 前检查、review 改动或只读检查时，执行本门禁：

1. 只基于 `git status`、`git diff`、`git diff --cached` 涉及的文件和改动片段检查。
2. 不格式化、不修复、不删除、不写文件，除非用户随后明确授权修改。
3. 每个适用检查项都要给出结论；不适用时说明原因。
4. 发现问题时按文件、位置或片段、问题类型、风险说明、建议动作列出。
5. 结尾询问用户要我按清单修改，还是由用户手动处理。

提交前重点检查：

| 类别 | 检查点 |
| --- | --- |
| 调试残留 | `console.log`、`[DEBUG]` 标记、临时 `try/catch`、调试节点、测试文案、`debug`、`temp`、`test` 标识 |
| 语法和类型 | 字符串或模板拼接错误、未使用 import 或变量、TS 类型缺口、RPC 必填参数缺失 |
| 边界条件 | 空引用、接口字段判空、小程序 rect 或 DOM 判空、`if ([])`、`res || 1` 这类误兜底 |
| 行为风险 | 临时 return、展开覆盖、同步删除后引用未更新、路由跳转或卸载后仍 setState |
| 资源清理 | `removeEventListener`、`clearTimeout`、`clearInterval` 等销毁清理 |
| 环境污染 | 测试环境 URL、硬编码测试数据、公共模块里混入子应用定制、Vue scoped 遗漏、手写浏览器前缀 |
| 临时代码 | 注释掉的调试块、过时注释、TODO、待确认、待产品确认 |

## 代码文件门禁

| 文件类型 | 优先动作 |
| --- | --- |
| TS、TSX、JS、JSX | Prettier，再 ESLint fix，再相关测试 |
| SCSS、CSS Modules | Prettier，再 Stylelint fix，再样式契约或截图验收 |
| JSON | Prettier 或 JSON parse |
| package、lint、formatter 配置 | 先解析配置，再运行最小检查 |
| 服务端 JS | `node --check` 加相关 `node --test` 或 contract |

## 文档和 skill 文件门禁

Markdown、skill 文件、中文文档至少检查：

1. UTF-8 可读。
2. YAML frontmatter 存在 `name` 和 `description`。
3. description 只放触发信息，正文放执行流程。
4. 没有明显乱码。
5. 链接到的关键 reference 路径存在。
6. 输出结构符合用户要求。

可用命令示例：

```powershell
Get-Content -LiteralPath <file> -Raw -Encoding UTF8
Select-String -LiteralPath <file> -Pattern '^name:|^description:'
```

Skill 官方校验需要 `PyYAML`。Windows 中文环境下先启用 UTF-8 模式，避免 Python 按 GBK 读取中文 `SKILL.md`：

```powershell
python -m pip show PyYAML
$env:PYTHONUTF8='1'
python <path-to-skill-system>\scripts\quick_validate.py <skill-folder>
```

## 常见项目命令

Taro、React、H5 项目优先查 `package.json`。若项目已有脚本，优先：

```powershell
npm.cmd run quality:fix
npm.cmd run quality:check
```

Node 服务优先：

```powershell
npm.cmd run test:unit
npm.cmd run test:contracts
node --check <changed-file>
```

样式契约常见入口：

```powershell
node src/pages/<page-name>/test/layout.test.cjs
node src/pages/<page-name>/test/gapCompatibility.test.cjs
node src/subPackage/<module-name>/test/figmaVisual.contract.test.cjs
```

## 报告口径

最终报告必须说明：

- 哪些文件被改。
- 跑了哪些命令。
- 命令是否通过。
- 未跑的检查和原因。
- 剩余风险属于本轮改动还是历史问题。

## 调试日志、ESLint 例外与桌面产物

- 禁止长期 `console.log` / `debugger`。提交前对改动文件搜索；请求层禁止打印完整请求响应。
- 生产日志只输出结构化摘要：`module`、`url`、`method`、`code`、`requestId`。
- ESLint 长期关闭必须写范围、原因、退出条件。常见例外：`exhaustive-deps`、`no-console`、`no-explicit-any`、`vue/no-v-html`。
- Electron / 影像 / PDF 不单开专题：IPC 与 preload 暴露面要最小；影像资源与桌面构建走独立产物；PDF 生成、上传、blob、跨域分开处理。

## 反模式

- 不只跑测试后跳过格式和 lint。
- 不在 dirty tree 里全量格式化无关文件。
- 不新增 formatter 脚本后忽略 `.prettierignore` 或 Stylelint ignore。
- 不把失败命令包装成通过。
- 不把真实外部接口混进普通轻量测试。
- 不因为是文档改动就跳过 UTF-8 和 frontmatter 检查。

## 输出格式

1. 结论摘要
2. 修改文件清单
3. 改动目的
4. 可执行步骤
5. 验收方式
6. 未改事项

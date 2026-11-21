# tools/build/

构建工具，用于生成可运行的应用。

## 工具列表

- `restore.mjs` - **主构建脚本**，从上游数据还原应用到 `app/`
- `format-shell.mjs` - 格式化 shell 输出
- `format-workflow.mjs` - 格式化工作流数据
- `summarize.mjs` - 生成项目分析摘要

## 使用

```bash
npm run restore   # 执行 restore.mjs
npm run summary   # 执行 summarize.mjs
```

## 输入输出

- **输入**: `upstream/`, `evidence/`
- **输出**: `app/`

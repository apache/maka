# tools/

REA 复刻项目的工具脚本集合。

## 目录结构

- **collect/** - 数据采集工具（抓取原站资源）
- **analyze/** - 分析工具（检查依赖、导入、补丁等）
- **build/** - 构建工具（还原应用、格式化输出）
- **verify/** - 验证工具（测试各模块功能完整性）

## 常用命令

```bash
npm run restore  # 构建应用到 app/
npm run verify   # 运行全部验证测试
npm run summary  # 生成分析摘要
```

# upstream/

原站资源和分析数据存档。

## 目录结构

- **captured/** - 从原站抓取的原始资源
- **readable/** - 可读格式的转换数据
- **analysis-input/** - 输入分析数据
- **analysis-navigation/** - 导航分析数据
- **analysis-workflow/** - 工作流分析数据

## 数据流

```
原站 → tools/collect → upstream/captured → upstream/readable → evidence → tools/build → app
```

## 注意

此目录内容为只读参考，构建时不应修改。

# evidence/

证据和验证数据存放目录。

## 主要文件

### 采集数据
- `capture-20261022/` - 新上下文采集数据（独立存放）
- `capture-report-20261022.md` - 采集报告
- `restoration-manifest.json` - 当前运行基准的实际生成清单

### 分析结果
- `rea-summary.json` - REA 三组分析摘要
- `rea-*-analysis.json` - 各类分析结果（business, navigation, workflow）
- `*-manifest.json` - 各类资源清单

### 验证证据
- `page-recheck-20261022.md` - 页面复查结果
- `visual-acceptance.md` - 视觉验收范围与更正
- `browser-acceptance.json` - 浏览器操作记录
- `editor-mode-acceptance.json` - 编辑器模式验收
- `verification.json` - 自动验证结果

### 数据文件
- `*-data.json` - 各类业务数据（component, mode-support, sidebar, workflow 等）
- `*-resources.json` - 资源索引
- `versions-*.json` - 版本配置数据

## 注意

- 新采集数据独立存放在 `capture-20261022/` 子目录，不覆盖旧基准
- 验证结果与当前运行基准对应，新上下文需独立校验
- 采集包不包含认证令牌或测试凭据

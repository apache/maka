---
name: tushare-finance
description: 获取中国金融市场数据（A股、港股、美股、基金、期货、债券）。支持220+个Tushare Pro接口：股票行情、财务报表、宏观经济指标。当用户请求股价数据、财务分析、指数行情、GDP/CPI等宏观数据时使用。
allowed-tools:
  - Bash(python:*)
  - Read
---

# Tushare 金融数据 Skill

本 skill 通过 Tushare Pro API 获取中国金融市场数据，支持 220+ 个数据接口。

## 快速开始

### 1. Token 配置

**询问用户**：是否已配置 Tushare Token？

如未配置，引导用户：

1. 访问 https://tushare.pro 注册
2. 获取 Token
3. 配置环境变量：`export TUSHARE_TOKEN="your_token"`

### 2. 验证依赖

检查 Python 环境：

```bash
python -c "import tushare, pandas; print('OK')"
```

如报错，安装依赖：

```bash
pip install tushare pandas
```

## 常用接口速查

| 数据类型 | 接口方法               | 说明              |
| -------- | ---------------------- | ----------------- |
| 股票列表 | `pro.stock_basic()`    | 获取所有股票列表  |
| 日线行情 | `pro.daily()`          | 获取日线行情数据  |
| 财务指标 | `pro.fina_indicator()` | 财务指标（ROE等） |
| 利润表   | `pro.income()`         | 利润表数据        |
| 指数行情 | `pro.index_daily()`    | 指数日线数据      |
| 基金净值 | `pro.fund_nav()`       | 基金净值数据      |
| GDP数据  | `pro.gdp()`            | 国内生产总值      |
| CPI数据  | `pro.cpi()`            | 居民消费价格指数  |

**完整接口列表**：查看 [接口文档索引](reference/README.md)

## 数据获取流程

1. **查找接口**：根据需求在 [接口索引](reference/README.md) 找到对应接口
2. **阅读文档**：查看 `reference/接口文档/[接口名].md` 了解参数
3. **编写代码**：
   ```python
   import tushare as ts

   # 初始化（使用环境变量中的 Token）
   pro = ts.pro_api()

   # 调用接口
   df = pro.daily(ts_code='000001.SZ', start_date='20241201', end_date='20241231')
   ```
4. **返回结果**：DataFrame 格式

## 参数格式说明

- **日期**：YYYYMMDD（如 20241231）
- **股票代码**：ts_code 格式（如 000001.SZ, 600000.SH）
- **返回格式**：pandas DataFrame

## 接口文档参考

**接口索引**：[reference/README.md](reference/README.md)

接口文档按类别组织：

- 股票数据（39 个接口）
- 指数数据（18 个接口）
- 基金数据（11 个接口）
- 期货期权（16 个接口）
- 宏观经济（10 个接口）
- 港股美股（23 个接口）
- 债券数据（16 个接口）

## 参考资源

- **Tushare 官方文档**：https://tushare.pro/document/2
- **API 测试工具**：https://tushare.pro/document/1

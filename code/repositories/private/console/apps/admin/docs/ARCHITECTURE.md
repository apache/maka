# ARCHITECTURE

单包 main，5.5k 行；RuoYi 存量 schema 原样复用（32 张表零迁移）。本文描述当前真实装配，改动行为须同步更新。

## 1. 模块图

```
请求 → gin.Default()（Logger+Recovery） → /api 路由组 → handler 函数 → GORM → MySQL(ry 库)
横切件：
  response.go   统一响应包络 Ajax/TableData（code 200/500/401，全部 HTTP 200）
  rbac.go       AuthRequired（token→LoginUser 入 ctx）+ RequirePerm(权限串)
  auth_guard.go LoginGuard 登录失败锁定 + DataScope 数据权限解析
  xss.go        XssFilter（写请求 JSON body 转义）+ RepeatSubmit（5 秒防重）
  logs.go       OperLog 中间件（写操作自动记 sys_oper_log）
  config.go/db.go   环境变量配置 + GORM 连接；models.go 全部 GORM 模型
  tree.go/util.go   部门树 DFS 展平等纯函数
```

## 2. 一次请求的运行时路径

main.go 装配顺序：`Load()`（环境变量）→ `MustOpen`（GORM 连 MySQL，MaxOpenConns=10，Ping 失败即 panic）→ `TokenStore`（内存，30 分钟滑动过期）→ `LoginGuard`（N/M 读 sys_config，缺省 5 次/10 分钟）→ `RepeatGuard` → Scheduler 启动（robfig/cron 秒级）→ 路由：公开路由（/auth/login、/captcha、/docs、/captcha-selftest；/common/upload(s)、/common/download/resource 单独挂 AuthRequired）→ `g` 组挂 AuthRequired → `managed` 组再挂 XssFilter → RepeatSubmit → OperLog（写请求）→ 各领域组每条路由包 `RequirePerm("<模块>:<资源>:<动作>")` → handler 查 GORM → `ok/fail/table` 返回包络。

## 3. 外部依赖与配置来源

- 依赖仅 Gin、GORM（mysql driver）、base64Captcha、robfig/cron、gopsutil、excelize。
- 配置全部环境变量：`LILIYA_DSN`（缺省 `root:password@tcp(127.0.0.1:3306)/ry`）、`LILIYA_ADDR`（代码缺省 :8080，README 冒烟用 :18777）；TokenTTL 硬编码 30 分钟。
- 运行期读库：登录锁定参数读 sys_config；定时任务表 sys_job；代码生成读 information_schema。
- 静态件：static/openapi.json + swagger.html（/api/docs）；上传落 ./upload/YYYY/MM/DD/（.gitignore 已排除）；模板在 templates/。

## 4. 失败行为

业务错误统一 HTTP 200 + 包络 code：500 fail（对齐存量 AjaxResult）、401 未认证（AuthRequired/RequirePerm 拦截，unauthorized 同包络）。panic 兜底靠 gin.Recovery；启动失败硬 panic（数据库不可达、端口占用、调度器起不来），不做静默降级。定时任务执行失败写 sys_job_log 不中断调度。

XssFilter、RepeatSubmit、OperLog 读取请求体失败时返回包络 code 500 并中止后续 handler，禁止把部分请求体当成完整输入放行。Excel 导出与导入模板在工作表、单元格或序列化失败时返回失败包络。认证中间件写入会话的类型不变量保持原样，错误装配仍由 panic/Recovery 暴露。

## 5. 边界规划

不预防性拆包。拆分触发：两个领域互伸手（跨文件直查对方表结构/绕过对方 handler）时，把最独立的领域切成第一个 `internal/<domain>` 包。依赖方向规则：internal/<domain> 只依赖 models.go 抽出的共享模型与横切件抽出的 internal/web（response/rbac 中间件），**不反向 import main 的其余部分**；main 只做装配。第一个包落地时在边界处放契约测试。

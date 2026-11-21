# Notes for coding agents

RuoYi 4.8.3（经典版单体）的 Go+React 重写之服务端：Gin+GORM+MySQL，单包 main 起步，复用存量 32 张表零迁移（schema 见存量 `sql/ry_20260319.sql`）。按文件划分的职责块：认证与会话（auth.go、auth_guard.go、captcha.go）、RBAC（rbac.go、roles.go、menus.go）、组织与用户（users.go、users_excel.go、depts.go、posts.go、profile.go）、系统配置与公告（configs.go、notices.go）、字典（dicts.go、tree.go）、监控（logs.go、serverinfo.go、cacheview.go、online.go、dashboard.go、dashboard_trends.go）、定时任务（scheduler.go、jobs.go）、代码生成器（gen.go、gen_render.go、codegen.go）、租户（tenant.go）、文件上传（upload.go）、安全横切（xss.go、p6.go、password.go）、基础设施（main.go、config.go、db.go、models.go、response.go、util.go）。

## 常用命令

- 构建：`go build ./...`
- 测试：`go test ./...`（11 个测试文件中 10 个为纯单测、无需数据库直接跑；auth_guard_test.go 需要 MySQL——`LILIYA_TEST_DSN` 可覆盖，缺省 `root:password@tcp(127.0.0.1:3306)/ry`，连不上自动 `t.Skipf` 跳过不算失败）
- 静态检查：`golangci-lint run ./...`（v2.14.0，配置见 .golangci.yml；本机二进制在 ~/go/bin/golangci-lint）
- 格式：改动文件 `gofmt -l` 输出必须为空
- 冒烟：Python 脚本先起服务再跑——`cd server && go build -o liliya-server . && LILIYA_ADDR=:18777 ./liliya-server`，另开终端 `python3 smoke.py`（端到端 24 项，base_url 缺省 `http://127.0.0.1:18777/api`；直连真库全链路，会创建 `gosmoke_` 前缀一次性用户并软删，不碰种子数据）。smoke_p1.py~smoke_p7.py 为各阶段分段脚本。

## Go 规范

根级约定见 /Users/ggbdpq/cc/AGENTS.md 与 .agents/skills/golang-*（code-style、error-handling、testing、concurrency、context、lint），按需读取。测试只用标准库，不引入 testify。

## 结构边界

单包平铺现状是有意的（5.5k 行尚可运转），不预防性拆分。拆分时机：两个领域开始互伸手（如 users 直接摸 roles 的表结构）时，把最独立的领域切成第一个 internal/<domain> 包，并在边界处放测试。新文件入包前先看 ARCHITECTURE.md。

## 工作纪律

- 修 bug 先写一个"把修复还原后必失败"的测试（现有黄金断言风格：期望值来自上游种子数据等独立事实源），提交说明写它在旧代码上以什么失败。
- 交付说明固定两行：已跑 X（结果）；未跑 Y（原因）。未跑不写成通过。
- 改动行为同步更新 README 的清单与 ARCHITECTURE.md；教训记 LESSONS.md（3 次重现升格为必查项）。
- 提交信息写可观察行为，一次提交一个目标。

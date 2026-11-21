# liliya

存量 4.8.3（经典版单体，Thymeleaf + Spring Boot）的 **Go + React 重写**——学习驱动的垂直切片项目。

数据库 schema 原样复用 存量 的 `sql/ry_20260319.sql`（32 张表零迁移），老库里的存量账号可以用原密码直接登录本系统（密码算法兼容复刻 `md5(loginName+password+salt)`，有黄金断言测试锁定）。

需求决策与边界见 [docs/2026-10-06-liliya垂直切片-需求澄清.md](docs/2026-10-06-liliya垂直切片-需求澄清.md)。

## 结构

```
server/   Go 1.25 + Gin + GORM（依赖仅此三件），单包扁平结构
web/      React 19 + TS 7 + pnpm 12 + Vite 8 + React Router 8 + Zustand + Zod + Tailwind 4 + shadcn CLI 4（@base-ui/react 原语）
docs/     需求澄清与决策记录
```

## 已实现（P0~P3 全量）

- 首页仪表盘：用户/角色/在线/登录统计卡
- 部门管理：树形 DFS 展平（depth 缩进渲染），ancestors 维护（孙级不级联为显式简化），有子级/用户禁删
- 角色管理：CRUD + 菜单权限树勾选（sys_role_menu 全量回显）+ 唯一校验 + admin 保护 + 用户引用禁删；data_scope 仅存储不实现过滤
- 菜单管理：树形 CRUD（M 目录/C 菜单/F 按钮），perms 为 RBAC 数据源；前端路由为静态注册，菜单管理是权限串与角色分配的数据管理界面（与存量 动态路由的差异已声明）

- 认证：登录 / 登出 / 会话信息；不透明随机 token + 内存存储 + 30 分钟滑动过期（对齐存量 classic 无 Redis 形态）；登录成功/失败写 `sys_logininfor`
- RBAC：权限串复用 `sys_menu.perms`，`user_id=1` 全通过（存量 isAdmin 语义）；前端按钮级权限同步
- 用户管理：分页列表 / 搜索 / 新增（服务端加盐加密）/ 编辑 / 重置密码 / 批量软删（禁删 admin、禁自删）
- 岗位管理：CRUD + 名称/编码唯一性 + 已分配岗位禁删
- 参数设置：CRUD + 键名唯一 + 内置参数（config_type=Y）禁删
- 通知公告：CRUD（正文 longblob，列表不拖正文，编辑先取详情）
- 操作日志：写操作中间件自动记录（模块标题/业务类型/参数脱敏 password/响应/耗时/部门），列表 + 清空
- 登录日志：成功/失败记录（UA 解析浏览器/OS），列表 / 搜索 / 清空
- 下拉数据：部门 / 角色 / 岗位 options（已并入各管理页）
- 字典管理：字典类型/数据 CRUD，类型改名连带数据、删除连带清理
- 定时任务：robfig/cron 秒级调度器（Quartz cron 兼容转换，TDD 黄金断言锁定种子表达式）；
  invoke_target 语义重定义为 Go 任务注册表（noop/echoParam），未注册目标执行记失败日志；
  任务执行写 sys_job_log，支持启停/立即执行；misfire 策略与并发控制首期仅存储
- 在线用户：token 元数据快照（IP/登录时间/最后访问）+ 强制下线

## 运行

```bash
# 0. 准备 MySQL：本机开发库容器（ry 库已含 32 表 + admin/admin123 种子数据）
#    DSN 默认 root:password@tcp(127.0.0.1:3306)/ry，可用环境变量 LILIYA_DSN 覆盖

# 1. 后端（默认 :18777）
cd server && go build -o liliya-server . && ./liliya-server

# 2. 后端可运行检查：黄金断言 + 端到端冒烟（24 项）
cd server && go test ./... && python3 smoke.py

# 3. 前端（vite dev 代理 /api → 127.0.0.1:18777）
cd web && corepack pnpm@12.9.1 install && corepack pnpm@12.9.1 dev

# 构建（tsc -b 全量类型检查）
cd web && corepack pnpm@12.9.1 build
```

种子账号：`admin / admin123`（原 存量数据）。

## 本机环境注意

- shell 若挂全局代理（http_proxy/all_proxy），本地 curl 需 `--noproxy '*'`；shadcn CLI 需剥掉代理变量
- pnpm 必须用 12.x（packageManager 已 pin）；shadcn CLI 内部会 shell 出去调裸 `pnpm`，需要 PATH 包装对齐版本（见 `web` 的 ERR_PNPM_UNEXPECTED_STORE 规避）
- TypeScript 7 已移除 `baseUrl`，paths 直接相对 tsconfig 解析
- @base-ui/react 的 Dialog/Menu 在本机环境存在退场过渡卡死与 Group 约束问题，已在 `web/src/components/ui/dialog.tsx` 与 `app-layout.tsx` 标注 ponytail 注释

## P4：存量 功能面对齐（全 18 项中的可迁移部分）

- 登录验证码：base64Captcha 画图 + 自研 2 分钟惰性过期存储（存量 Kaptcha 语义）；登录失败锁定：连续失败 N 次锁 M 分钟（读 sys_config，缺省 5 次/10 分钟）
- 数据权限：@DataScope 最小语义面（全部/自定 sys_role_dept/本部门/本部门及以下 FIND_IN_SET(ancestors) 精确匹配，同上游/仅本人），已注入用户列表查询
- 服务监控：gopsutil CPU/内存/磁盘 + Go runtime + **连接池监视**（sql.DBStats，对应 Druid 页的 Go 语义）
- 缓存监控：会话 token 缓存的键数/键列表（脱敏）/清空（对应 Redis 缓存监控页语义）
- 系统接口：手写 OpenAPI 3.0 spec（31 端点）+ Swagger UI（/api/docs）
- 用户 Excel 导入导出（excelize）：导出全量、导入模板、updateSupport 更新语义、初始密码 123456
- 种子数据清理固化：scripts/reset-seed.sh（幂等，历史上手写 DELETE 误删过种子部门 100/101）

## P5：最后两大件（存量 18 项收官）

- 代码生成器（第 13 条）：读 information_schema 导入表结构（存 gen_table/gen_table_column）→
  编辑生成配置 → 预览/下载 zip。生成物为 **Go（GORM 模型 + Gin CRUD 处理器）+ React（shadcn 列表页）
  + 菜单 SQL**（原版生成 Java/Vue——目标栈不同生成物必然不同，"读表→配置→生成"流程复用）；
  生成代码经编译验证（生成的 model go build 通过）；类型映射与命名转换为 TDD 黄金断言
- 表单构建（第 17 条）：组件面板/画布/属性编辑的设计器，点击添加+排序（拖拽为 UI 细节，功能等价），
  生成 **shadcn React TSX** 表单代码（原版生成 HTML——同上声明差异）

## P6：源码级清点补齐（CommonController/Profile/公告已读/安全中间件）

- 文件上传/下载（第 1 项依赖面）：/api/common/upload（单文件，扩展名白名单+50MB 上限）、
  /uploads（批量）、/download/resource（路径穿越防护，只放行 ./upload/ 目录内的文件）；上传目录 ./upload/YYYY/MM/DD/
- 个人中心（SysProfileController 语义）：本人资料查看/修改、**本人改密码**（验旧密码，区别于 admin 重置）、
  头像上传（photo 入口在头部下拉 → 个人中心页）
- 公告已读（sys_notice_read 表启用）：列表带 isRead 标记、打开详情即标记已读（幂等）、
  /system/notice/unread 未读数接口
- 用户注册（P6b 未做）：注册页与 sys.account.registerUser 开关——唯一明确遗留
- XSS 过滤（XssFilter 语义）：写请求 JSON body 字符串值 HTML 转义（<>&'"），
  公告正文与代码生成排除（前者允许富文本）
- 防重复提交（@RepeatSubmit 语义）：写请求 5 秒窗口，指纹 = token+实际路径+body 哈希
  （初版用路由模板误伤不同资源的同类操作，已修正为实际路径）
- XSS、防重复提交和操作日志中间件遇到请求体读取失败时中止处理并返回失败包络；Excel 导出与导入模板检查工作表、单元格和序列化错误。

## P7：租户管理 + 趋势图表（pure-admin-max 独有业务收口）

- 租户管理：租户 CRUD（套餐关联/过期时间/状态）、套餐 CRUD（被引用禁删）、
  过期状态展示（停用 > 已过期 > 永久）；租户为组织信息管理，不做行级数据隔离（与 RuoYi-Vue 多租户插件差异，声明）
- 趋势图表：/api/dashboard/trends（近 7 日登录/操作日志，FillTrendGaps 补零对齐——
  TDD 黄金断言；MySQL DATE() 分组表达式与 only_full_group_by 的兼容坑已用 DATE_FORMAT 解决）+
  recharts 双折线接入首页

## 明确不做（首期）

验证码、Excel 导入导出、代码生成器、表单构建、demo 页、Quartz、Redis、JWT、数据权限 dataScope——依据与理由见澄清文档第三节。

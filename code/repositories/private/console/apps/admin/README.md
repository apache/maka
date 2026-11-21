# @ggbdpq/admin

liliya —— 若依 4.8.3 存量管理后台的 Node 重写（原 Go 版退役后接棒，2026-10-25 并入 console 编队，端口 65505）。

## 技术形态

- Next.js 16（App Router）+ **node:sqlite**（Node 24 内置，零原生依赖），单进程无第二服务
- SQLite 方言重建若依核心 16 表（字段对齐 Go 版 models.go），落盘 `data/admin.db`（`ADMIN_DATA_DIR` 可注入）
- 密码算法形制保留存量口径 `md5(loginName + password + salt)`；认证为不透明随机 token + 内存会话 30 分钟滑动过期（对齐 Go 版 classic 无 Redis 形态，重启即全员下线属预期）
- 前端：通用 `crud-table.tsx` 配置驱动 + 树形/日志/在线用户定制页

## 模块清单（12 项全实现）

用户（分页/搜索/新增加盐加密/停用/重置密码/软删，禁删 admin、禁自删）· 角色（roleKey 唯一、内置保护、被引用禁删）· 菜单（M/C/F 树形、有子禁删）· 部门（DFS 展平缩进、ancestors 维护、有子级/用户禁删）· 岗位（编码/名称唯一、已分配禁删）· 字典（类型删除连带清数据、数据按类型过滤）· 参数（内置 Y 禁删）· 公告（列表不拖正文）· 操作日志（写操作自动记录、参数脱敏、可清空）· 登录日志 · 在线用户（token 快照 + 强制下线）· 定时任务（invoke_target 注册表 noop/echoParam，手动执行写 sys_job_log；**调度循环 P3 未接**，misfire/并发仅存储）

## 运行

```bash
pnpm dev        # http://localhost:65505（种子账号 admin / admin123）
pnpm typecheck
```

## 与 Go 版（lab/liliya，保留作对照）的边界

- 存量 MySQL 连接不复刻：SQLite 自建库 + 种子数据替代，老库直连能力随 Go 版退役
- 端点级 RBAC 已实现（2026-10-25）：49 项菜单/权限串种子（对齐 Go 版 RequirePerm 权限点）+ 13 组 API `denyUnless` 守卫 + 角色「分配权限」树勾选 + `/api/me`、登录响应返回 perms + 侧栏按权限过滤 + 登录按权限落位；授权变更即时生效（权限缓存全清）。user_id=1 全通过语义保留
- RBAC 余项：前端按钮级隐藏（页面入口已过滤，页内按钮未按 perms 细分）
- data_scope（本部门及以下）过滤未实现（Go 版后期特性）
- smoke_p1~p7 口径已抽验核心路径（唯一冲突/内置保护/树形删除守卫/日志自动记录/强制下线），未逐条复刻

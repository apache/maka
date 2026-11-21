# hunt-119 / 4917 lapsed-first-account 验证记录

- issue: https://github.com/yetone/magpie/issues/4917
- 分支: fix/4917-lapsed-first-account（基线 a3768cdd1 = upstream/main tip, 2026-11-02 22:02 +0800）
- commit: 812d1aa15 "plugin: a lapsed account kept first doesn't say the provider fell back (#4917)"
- patch: 0001-plugin-a-lapsed-account-kept-first-doesn-t-say-the-p.patch（SHA-256 first 16: 080fbc3f462f20c3）
- take: https://github.com/yetone/magpie/issues/4917#issuecomment-6582192538

## 根因判定（①）

报告者 headline 症状（清单缩到 [auto]、Fetch models again 报 1）在 v0.1.2729 的构建上由
「provider 级行字段跟随首账号」放大；tip（a3768cdd1）上 rowOf 已把各账号清单并成 union
（566ae09db, 2026-10-01），清单本身不再缩水——探针实测 provider Models=3（union）。
tip 上仍坏的是 provider 级 `fellBack`/`listError` 跟随首账号（lapsed+hidden oauth）：

- `magpie plugin list` 把 provider 说成 fell back（报首账号的 "HTTP 400" 类错误）；
- `keepListed`（internal/plugin/providers.go:488）在 `p.FellBack && !l.FellBack` 时把
  union 清单换回上一轮旧清单 → vendor 加/删模型被冻结/出鬼影；
- `pluginListedIDs`/`keptListed`/`dropGonePluginPicks`（plugin_relist.go:86,124）把
  provider 当「清单没读到」→ picks 摘除与回归停摆；
- 修复 = rowOf 的 fellBack 改为「没有任何账号讲出清单」（`p.fellBack && own.every(fallback/failed)`），
  listError 随之。逐账号字段不动（lapsed 账号条目仍诚实报错）。

## TDD（③）

- RED: TestLapsedFirstAccountKeepsTheProvidersList（internal/plugin/plugin_list_error_test.go）
  fake 插件复刻报告者形状：oauth refresh "r-dead"（hook 抛 "the vendor refused the sign-in"）
  占首键 fakeco，API key "live" 占次键；断言 provider 级 fellBack=false/listError=""、
  逐账号字段诚实、vendor 清单改名（extra→newer）后 union 跟动（keepListed 不冻结）。
  修前 FAIL @ "a lapsed first account said the provider fell back saying ... (fellBack true)"。
- 消融: 提交 812d1aa15 后 `git checkout HEAD~1 -- internal/plugin/host.js`（只回退产品文件，
  测试保留，基线=分支父提交 a3768cdd1）→ 测试回红（同一行 130）；恢复 → 绿。

## 矩阵（④）

| 检查 | 结果 |
| --- | --- |
| gofmt -l internal/plugin | 干净 |
| go vet ./... (darwin) | 退出码 0；internal/gui 两条预存 cgo -Wenum-conversion 警告（dockflap_darwin.go / trayimage_darwin.go，非本单文件） |
| GOOS=linux go vet -tags nogui ./... | 过 |
| GOOS=windows go vet ./... | 过 |
| go build (darwin) | 过（ld 预存噪音） |
| GOOS=linux CGO_ENABLED=0 go build -tags nogui | 过 |
| GOOS=windows CGO_ENABLED=0 go build | 过 |
| go test -tags nogui ./internal/plugin（改动包全量） | 1 失败 TestHostToldTheGatewayAddress —— **预存红**：基线 a3768cdd1 干净 worktree 同挂（host_addr_test.go:78 MAGPIE_ADDR 端口陈旧），与本单无关；单跑/全量同现 |
| go test -tags nogui -run 'TestPlugin\|TestRelist\|TestDropGone\|TestFallenBack\|TestKiro' ./internal/provider | 过（消费方包定向） |
| go test -tags nogui -run 'TestFetchedCount\|TestFetch' ./internal/gui | 过 |
| go test -tags nogui -count=1 ./...（全量） | 见文末补记 |
| -race | 未跑：本单无 Go 并发面改动（JS 行字段计算 + 测试），如实标注 |

## Watched 三查（⑤）

- 兄弟面 rg 全查：host.js `accountsOf(...)[0]` 共 5 类用点——accountKey（请求/usage/checkin/fetch/check，
  Go 总显式带账号键，无键时落首键为「没指名」既有语义，不改）；info() 的 ask 账号（修后 provider
  行字段不再依赖它讲没讲成；改它需协议扩展传 logins first keys，超范围，不改）；providers() keys[0]/
  slice(1)（消费处已修）；single（单身份一账号语义，不改）；forget/广播（按 key 枚举，无关）。
  Go 侧 provider 级 FellBack 消费方 3 处（keepListed / pluginListedIDs / keptListed）输入变诚实、
  逻辑不动；keep-last-good 在「全部账号 fallback」时保持（TestFallenBackListKeepsTheLastOne 全绿）。
  `magpie plugin list`（plugins_cli.go:293）的 accountId 仍按首账号显示（文档化语义 "the one kept
  under its own id first"，Go struct 注释同）——残留，不改，帖中如实说明。
- 失败读取语义：own 条目 hook 抛（strict）→ {failed:true} 计入「没讲成」；q 为空 → 计入 fallback
  （保守，不会误开 keep-last-good 旁路）；全部账号 lapsed → provider fellBack=true → 旧行为保持；
  provider off（quiet）→ p.fellBack=true、own=[] → fellBack=true → magpie 保留旧清单，不变。
- 热路径代价：rowOf 每 provider 每 listing 一次（relist 每小时/变更/启动），非请求热路径；新增
  own.every() 为账号数线性常数；每请求零新增开销。

## 全量补记

`go test -tags nogui -count=1 -p 4 ./...`：82 包 ok，5 个失败全部预存/合跑 flaky，逐一对基线
/tmp/mg119-base（a3768cdd1 干净 worktree）单跑定性：

| 失败 | 定性 |
| --- | --- |
| internal/agent TestMothX | 预存红（基线同挂，单跑即挂） |
| internal/cli TestEveryRouteHasACommandOrIsNamed | 预存红（基线同挂，单跑即挂） |
| internal/gui TestProxyCheckSaysAProxyPassedBy | 预存红（基线同挂，单跑即挂） |
| internal/gateway TestCodexPoolSaysTheClientsVersion | 合跑 flaky（本分支单跑 pass；hunt-116 帖已记同款） |
| internal/plugin TestHostToldTheGatewayAddress | 预存红（基线同挂，单跑即挂） |

附注：第一次全量（后台 `>` 重定向）日志在结束时刻被截断只剩退出行（13 字节，机制未深究）；
换 `tee` 双写重跑得到完整日志 /tmp/mg119-full2.log，两轮退出码均为 1 且失败集合一致（第一轮
plugin 包单独跑已见 TestHostToldTheGatewayAddress）。

-race：未跑（本单无 Go 并发面改动），如实标注。

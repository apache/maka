# #4668 Codex responses socket 重建内存（hunt-115-b8）

- 帖：https://github.com/yetone/magpie/issues/4668#issuecomment-6558308318（take: #issuecomment-6557888972）
- 分支：fix/4668-socket-rebuild-memory @ 446f55f6811b5dae025549f7e4f986d59bb6f2a8（fork 已推）
- patch sha256 前16：4aa7d4e6b0e185a9
- 开工 SHA：9d08993c8（upstream/main，发布前复查无新提交无碰撞）

## 判面
- 0.1.2477 后维护者已修三大头（均未引 issue 号）：a51776f9c（双 json.Marshal ~5 份/轮）、ec0a11d47（held reply pin 整 frame ~39MB live heap＝报告者高水位主因）、ed5872d18（prev_response 持整 body）。
- 本单补：readRequestBody 对已在内存的 turn body 再读一份（readSized）→ wholeBody 零拷贝快路径；兄弟面 codexOwnOffMagpie（同机制同量级）一行同改；ended 日志行加最长 turn body（reporter 建议4）。
- 架构拍板未动：JS middleware 整份 body 进 JSC（插件宿主 2.6GB 的机制）；socket 转发不终结。
- 高水位回落：idle_memory.go 已有（30s 空闲 FreeOSMemory，counted 覆盖 socket turn）；修前收不走系 live pin。

## TDD/消融
- RED1 TestSocketTurnBodyReadOnce：1,151,959B body 分配 2,211,820B（阈值 len/4 红）
- RED2 TestResponsesSocketLogsLongestTurn：日志行无 longest turn 字段红
- GREEN：6,528B（0.006x）；消融1（去快路径）回红 2,211,820B；消融2（去日志字段）回红
- 矩阵：定向族 ok；gateway 全量 -tags nogui 两次（amend 前 576s / 后 536s）ok；vet darwin/linux/windows + gofmt clean；build 三平台 ok
- 热路径代价：readBoundedRequestBody 每请求 +1 次类型断言（ns 级）
- 兄弟面不改：video/draw/image_mcp（小 body 本地 API）、codex_dropped/signin_revoked（http.Response 非 request）、其余 NopCloser(bytes.NewReader) 直发 transport 不经 readRequestBody

## 未验证
- 未在 8GB Mac 长 Codex 会话复现 footprint 数字（分配差分≠驻留）；未跑 -race

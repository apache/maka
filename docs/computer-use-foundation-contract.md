# Maka Computer Use Foundation Contract

状态：Accepted
适用范围：Desktop foundation；CLI 仅实验性 opt-in；`@maka/headless` 暂不纳入
目的：定义 stacked PR 不可破坏的合同与验证门。

外部证据参考（不属于本仓库）：

- `codex-computer-use-lab/docs/08-wrapper-policy-and-toctou.md`：canonical app approval、pre-await snapshot、approval 与 action freshness 分离；
- `codex-computer-use-lab/docs/13-policy-error-state-machine.md`：policy → approval → fresh observation → action，以及 intervention/lock/blocked URL 状态；
- `codex-computer-use-lab/docs/16-service-process-lifecycle-and-retention.md`：exact executable ownership、client/idle lifecycle、connection-loss cleanup；
- `codex-computer-use-lab/docs/19-electron-presentation-and-mcp-event-contract.md`：presentation 与 native action transport 分离。

上述文件位于独立逆向实验仓库。本文只记录由 Maka 测试锁定的合同，
不把外部路径声明为本仓库内链接。

## Contract

1. Observation authority
   - 每个可执行 observation 具有唯一 `frameId + epoch`、截图尺寸、`pid + windowId`、capture-local 坐标信息，以及适用时的 Electron page identity。
   - 坐标只能在产生它的截图/窗口 frame 内解释。dispatch 禁止重新选择当前全局坐标下的最高 z-order 窗口。
   - 新 observation、turn/session 结束、abort、user stop、service loss 和明确 intervention 使旧 action claim 与 keyboard ownership 失效。

2. Action binding
   - mutation 在第一次异步边界前完成参数快照、规范化、fingerprint、claim，并绑定 active observation。
   - 有顺序依赖的动作按 Computer Use session 串行；不同 session 不全局串行。
   - stale、replay、unclaimed、malformed、targetless action 均 fail closed，不得回退到裸 pixel、foreground activation 或当前系统焦点。

3. Exact target validation
   - coordinate action 在 dispatch 前验证同一 window identity、geometry、screenshot scale、page identity 和 occlusion。
   - semantic action 优先按稳定 token refetch；否则仅允许唯一且 identity-preserving 的匹配。缺失、歧义、越界、遮挡或 page 变化必须失败。
   - 无关 AX/DOM 内容变化不能合成 `user_intervened`。物理介入和 terminal host state 必须来自明确事件。
   - drag/zoom 两端必须属于同一个 bound window。

4. Execution ownership
   - maka-cu 是唯一 native executor；window/page discovery、semantic preparation、input dispatch 和 effect readback 均留在该边界内。
   - agent 不得移动真实鼠标、抢前台焦点、临时 activate 窗口或执行 windowless desktop input。
   - keyboard ownership 绑定 `session + turn + generation + pid + windowId + page/frame`，并在失败、stale、新 observation、intervention、service generation 变化、turn/session 结束时撤销。
   - child process 在未知 action outcome 下退出时必须 re-observe，禁止自动重放。

5. Postcondition
   - mutation 成功后旧 observation 被消费并返回 fresh full observation；可获得视觉状态时向模型返回新截图。
   - transport success 不等于 business success。`verified:true` 必须由 action-specific effect/readback 支撑。
   - `supported:true, ok:false` 为本次 terminal failure；仅 side-effect-free 的 `supported:false` 可进行一次显式允许的 fallback。
   - retry 基于 fresh observation 和新 claim，禁止重试旧 coordinate/fingerprint。

6. Service lifecycle
   - executable、version、hash、role 和 generation 必须 runtime-observable；dead/mismatched child 不得复用。
   - startup、request、shutdown、restart 均有界；成功恢复后重置连续失败预算。
   - process exit 清理 pending request、observation、keyboard ownership、presentation 和受影响 session lease。
   - capability 反映实时 `healthy / degraded / unavailable`，不能只检查 binary path。

7. Approval and privacy
   - approval 是 app capability gate，不是 active observation 或 action freshness 证明。
   - Maka 采用分级短 lease：metadata read、screenshot read、pointer mutation、keyboard mutation、semantic mutation 分离；目标、action class、observation 或 session generation 变化时重新授权。
   - approval 至少标明 action class 与目标 app/window；敏感应用、secure/password field 和不支持的目的地 fail closed。
   - screenshot、typed text、coordinate、raw AX label/value、window title、secret 和 raw page content 默认不进入持久 session log、telemetry 或 evaluation report。
   - 上传截图前验证 model vision capability，并满足对应用户/provider consent policy。

8. Presentation isolation
   - cursor/PiP 位于 targeting 下游，不能选择、转换、授权或改变执行坐标。
   - `readyForInteraction` 只能通过有界 fail-open 策略影响 dispatch 时机；`finished` 不阻塞 native dispatch 或 postcondition。
   - completion 使用 executor-resolved point；失败、abort、teardown、supersede 或缺少 completion point 时必须 cancel。
   - acknowledgement 按 session + action identity 绑定，stale ack 必须忽略。

## Validation Matrix

`PASS`：当前证据直接覆盖；`PARTIAL`：组件证据存在但 production 闭环不足；`FAIL`：当前实现违反合同；`UNKNOWN`：缺少足够证据。

本矩阵记录 #857 拆分链建立时的基线状态，用于界定各 stacked PR 的验证责任。拆分链合入后，各领域当前状态以源码与合同测试为准。

| Contract area | 状态 | 当前证据 | 拆分链需要的证据 |
|---|---|---|---|
| Frame/window binding、duplicate rejection | PASS | frame state、bound-action、stale/duplicate tests | 在 Runtime slice 保留 focused tests |
| Capture-local coordinate authority | PASS | window-local transform、scale/geometry、Retina/negative-origin tests | decoy window 下的 cumulative Desktop E2E |
| Page identity、driver-only executor | PARTIAL | PID-owned CDP/page resolution，无 direct executor bypass | document replacement test；填充 `documentFingerprint` |
| Semantic identity refetch | PARTIAL | unique refetch、missing/ambiguous rejection | token mismatch 不得接受 replacement control |
| Occlusion、no foreground/pixel fallback | PASS | coordinate/semantic occlusion 与 fail-closed tests | real-window safety sentinel |
| Fresh postcondition、effect verification | PARTIAL | mutation 后要求 fresh observation，部分 readback | 所有 advertised mutation 的 cross-layer tests |
| Per-session queue、generation lease | PARTIAL | session queue/frame claim；lease 修复尚在本地 | concurrent-session 与 intervention-before-dispatch tests |
| Physical intervention、lock、stop | FAIL | 有状态机原型，无 Desktop production event producer | 真实 host wiring 与 transition tests |
| Service recovery、unknown outcome | PARTIAL | 本地 service abstraction 与 unit tests | restart reset、attestation、child-crash、cleanup E2E |
| Approval semantics | FAIL | 旧实现是整 turn scope | 分级 lease、脱敏 permission event、sensitive-target tests |
| Privacy、telemetry | FAIL | 旧 observation/tool args 可含敏感内容 | persistence/redaction tests；allowlist report schema |
| Presentation lifecycle | PARTIAL | 本地 candidate 存在；远端 #777 与 #699 相同 | 重建 presentation-only PR 与 cumulative E2E |
| Provider/model compatibility | PARTIAL | Desktop 默认走统一 function harness | vision gate；每个准入 model 的 real-runtime evidence |
| Binary provenance | PASS | source/archive/binary/license pinning | 独立 supply-chain verifier |
| Signed packaged app | UNKNOWN | 无 `.app` signing/notarization/Gatekeeper 证据 | nested helper、TCC chain、cold-start package smoke |

## Split Gate

每个 stacked PR 必须写清：负责的 contract 条款、non-goals、exported interface、focused verifier 和 cumulative verifier。重建从最终已验证 tree 按目标文件/hunk 提取，不机械重放旧 73-commit 历史。

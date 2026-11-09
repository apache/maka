<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Root native interruption: assertion migration map

这是源码证据表，不是运行结果。未运行编译、测试、格式化或探测。
旧文件 `native_turn_interruption.rs` 的三个用例直接构造 ledger 事件和 interruption DTO，
并未覆盖 normal SDK + OS 端到端路径；迁移不以新建这种路径为前提。
下列“已有”只表示已亲读实际断言，不表示测试通过。原断言的分层映射已 SourceReady；按父任务授权退休旧 Rust 实体，main 注册由父任务单独配对移除。本表不宣称 normal SDK + OS、同对象 browser/page 端到端覆盖。

## 精确证据索引

| ID | 实际文件、函数及观察边界 |
| --- | --- |
| S1 | `plugins/agent/state/tests/native_turn_source.rs::native_source_requires_exact_execution_identity`：真实 State admission/DriverClaim，Cell original RecoveryRef；wrong session/turn/run/full original 负例均先在未 retired 的旧票下完成。原 Run 尚未 interrupted，rebuild 后仍 false；随后真实同 stable Run replacement claim，旧票精确 `superseded driver claim`，新票完整 ExecutionIdentity 不变；此后才对原 binding 用 fresh FactId 首次 native_interrupted，须 true。再 rebuild 后原 Run fence true/other Run false，旧票仍 superseded、新票完整 identity 仍等原 execution。已亲读此顺序，SourceReady 非 pass；不造新 grant，也不证明 SDK opaque source authenticity。 |
| S2 | 同文件 `native_turn_fence_is_run_scoped`：两 Run 明确同 presentation turn、不同 run_id；first fence/second 未 fence，first 新 binding 拒绝、second binding 成功；ComputerApp subject/status 在 fence 前后及 rebuild 后均保留、`stopped == false`。ComputerApp 不是 SDK BrowserSource。 |
| S3 | 同文件 `late_native_interruption_keeps_original_binding_scope`：old 已 Completed，current 新 Run；current 冒 old binding 拒绝，old 原 FactId 第一次 true、重复 false；old fence/current 不 fence，current bind 成功；rebuild、真实 close/reopen 后 scope 不变。 |
| D1 | `platform/computer-use/src/desktop/worker/connection.rs::native_observer_tests::retained_native_proxy_allows_idle_escape_and_maps_only_the_bound_parent_epoch`：实际 duplex framing、Connection run/route/begin_browser；A Bound ACK 后原 Response 保留；A Interrupted 原 observer future Pending 时，同 session/turn/outer epoch 的不同 execution B 真正 admitted/Bound。释放 A 原 future 后 ACK 仍 A identity，A event 的 op/epoch/execution/generation 不变，B 仍 Pending；B 自己 Interrupted/Drained 后原 Response 不改，晚 drain 拒绝；原 Shutdown/router join。不是 OS key 或 SQLite 测试。 |
| D2 | 同文件 `tests::native_bound_wire_refuses_forgery_without_poisoning_the_original_invocation`：15 项真实 framed Bound 负例，outer owner/epoch/session/turn/execution/op，inner session/turn/execution/op，空 inner epoch，空/nil/invalid generation，无 pending；均 Failed、observer 未调用、原 future 仍 Pending。正常 Bound 仍成功并读 SDK 实际 sealed source；A 终态再 Bound 不污染已 admitted B，B 正常 Bound/原结果成功。非空 inner epoch 与 outer 不同是映射正例。 |
| D3 | 同文件 `native_observer_tests::drain_uses_exact_unacknowledged_affected_operation_not_the_binding_producer`：source-A 与 affected-B 分开；只有 B observer 收到 drain，proof 同时保 A producer 和 B affected operation；已 response 后拒绝晚 drain，原计数不变。 |
| D4 | 同文件 `native_observer_tests::observer_future_survives_wire_eof_while_actual_owned_child_is_reaped`（Linux）：实际 owned shell child、framing、EOF/reap；原 observer 被 gate 保留，child 已退出但 connection 未 close；释放同一 future 后只记录一次。不是物理输入。 |
| D5 | 同文件 `tests::known_response_survives_subsequent_transport_eof`：原 Response 值在随后真实 transport EOF 后仍保留；不是 Root persisted result。 |
| D6 | `platform/computer-use/src/desktop/worker/native_owner.rs::tests::observer_upgrade_joins_original_binding_and_delayed_old_ack_cannot_retire_replacement`（Windows/native-desktop）：实际 NativeRetire 控制 ACK 前 B 不注册；A/B 实际 source Arc 不同；晚 duplicate A ACK 后 B 未 retired、B 原结果保留，后续 C 仍使用 B 原 source、只注册一次 B。原 source A 无 observer binding，该限制不隐去。 |
| D7 | `platform/computer-use/src/desktop/worker/callbacks.rs::tests::exact_execution_seal_keeps_same_turn_original_effect_of_another_execution_live`：实际 worker/parent callback bridge，两 effect future 只差 execution；seal A 后 A 拒绝、B preparation check 成功、A bindings 空/B 一个，两个原 future 各自结束。是 browser effect scope，不是 Root/OS。 |
| D8 | 同文件 `real_callback_bridge_refuses_foreign_old_and_sealed_effect_scope_without_host_check`：foreign token epoch 拒绝；wrong effect/turn/execution 返回 Failed；seal 后原 scope 拒绝、actual bindings 空、worker 无新请求，原 future 正常结束。不是 Root WorkIssuer 全身份验证。 |
| D9 | `platform/computer-use/src/desktop/worker/epochs.rs::tests::finishing_a_turn_drains_its_original_wait_without_cancelling_the_later_turn`：原 future 11、fresh-turn 12、same-turn/different-execution 13；只结束 11，12/13 不取消，随后分别接原 Response。 |
| C0 | `plugins/workspace/workspace-computer/native/src/browser_access.rs::tests::Fixture::with_code`：真实 App + production provider + HTTP selected cua_repl T0/T1。`lib.rs::Computer::call` 在实际 NativeCallContext、Root custody/session、完整 execution、bind_original 检查后捕获 Call。fixture 直接核 actual Run、scope identity、Root Arc、canonical tool key/call/input/original。是实际消费者 provenance，不另算测试用例，也不冒称 negative custody 已测。 |
| C1 | `plugins/workspace/workspace-computer/native/src/sessions.rs::tests::old_prepared_vm_retirement_does_not_finish_the_new_vm_in_the_same_turn`：同 actual execution 下实际旧 kernel retire、新 kernel；旧 epoch retirement/observer 结束后新 gate 仍 open、新 receipt 仍一个。不是 NativeSource ACK，也不是新 actual Run。 |
| C2 | 同文件 `cleanup_retries_after_failure_and_joins_an_inflight_retry`：actual entry.turns[actualRun] 原 cleanup；真 native mutex 延迟原 retry，第二调用 join 而非重跑；释放后 await 原 retry/cleanup，source_lease 为 None。未绑定 opaque interruption source，不能冒 late native writer ACK。 |
| C3 | 同文件 `idle_browser_basis_revoke_seals_producer_and_waits_for_original_native_cleanup`：真实 metadata revoke、原 gate、native mutex、原 cleanup 与 resources settlement Pending；释放后原 cleanup 完成、receipt 清空。是 policy revoke，不是 NativeTurnInterrupted。 |
| C4 | `plugins/workspace/workspace-computer/native/src/browser_access.rs::tests::fixed_ui_targets_recheck_real_global_basis_turn_gate_and_operation`：actual Call authority，wrong operation/execution 的 policy DTO 被 scope 拒绝；basis/gate/cancel/terminal 分支拒绝。明确不是 SDK tab ownership/source authenticity。 |
| C5 | 同文件 `actual_host_service_revoke_blocks_new_checks_but_keeps_original_started_ticket_pending`：actual HostEffects scope，revoke 后新 check 拒绝而原 effect/settlement 仍 Pending；原 worker EOF 后才结束。不是 NativeSource ACK。 |
| H1 | `plugins/workspace/workspace-computer/native/src/evaluate/browser_handoff_test.rs::real_host_retained_browser_pages_survive_handoff`：原 hardware-ignored smoke；四段真实 script，三次 next_call 真 Host.send，fixture 核新 actual Run/原 key/input/ref；同 generation release/reacquire 及 handback 后新 browser generation/owned pages。原 receipt reader + artifact session/turn 断言。JS globals 有意跨调用保留，不能证明新 VM、Unknown、native Escape；不是普通 CI 的替代证据。 |
| R1 | `platform/event-log/tests/root_retention.rs::original_retention_tokens_allow_late_ack_and_release_only_their_owner`：真实 accepted A/B work custody、原 writer、原 retention token、A fork。Root shutdown 失败后原 writer 仍可 late ACK；确认 A 后 A writer 关闭/B 仍可写；A fork 未 finish 时仍 Pending，finish 后 A settle；B 独立确认/settle，RootOwner Weak 实际释放。不是 Agent DriverClaim/SDK Source 复合测试。 |
| R2 | `platform/event-log/src/root_store/execution/tests.rs::work_effect_retains_cancellation_and_settlement_after_observer_finishes`：真实 WorkCustody；foreign session fork 和 actual foreign parent custody 拒绝；原 effect/同 parent sibling 的取消隔离。不是 SDK WorkIssuer 完整 execution 验伪。 |
| E1 | `plugins/agent/engine/tests/integration/continuation_recovery.rs::handoff_claim_preserves_turn_and_frozen_ancestry_without_releasing_reserved_identity`：真实 shared NativeFixture，连续两次同 stable Run 新 DriverClaim，旧 claim 拒读写，DriverExit::Retired、history 不变，单 Run/无 successor；close/reopen 后 history/spec/frozen request 全等。没有 NativeSource/Unknown 组合。 |
| E2 | `plugins/agent/engine/tests/integration/root_startup_recovery.rs::startup_recovers_model_and_call_cuts_across_multiple_pages_in_opening_order`：n2 的真实 Unknown receipt 内联于原 `Fact::OperationObserved`，不是独立 ToolReturn output ContentRef。已亲读父任务补充：首次 shutdown 前保存原完整 RecordedFact/序列化 bytes 及同 tool 原 ToolDecided.input ContentRef/真实 state.content bytes；reopen 立即及原 Stop/Blocker/RiskCancel terminal 后，均由原 FactId 的 fact_barrier 核完整 fact、序列化 bytes、原 input bytes 全等。原 Root.operation 原 reference 的 Unknown outcome、257 admissions、ToolAdmitted/OperationObserved 次数、effects == 2 和不重放断言保留。Source-ready，不是通过。 |
| E3 | 同文件 `initialization_and_reopen_preserve_facts_payloads_and_schema_identity`：canonical facts/spec/content bytes 跨 reopen 全等，原 RecoveryRef dispatch 非 New/effects 一次。该 lane 是 Returned，不能代签 Unknown bytes。 |
| N1 | `plugins/agent/native/src/owner/tests/service_tools.rs::unknown_service_outcome_has_typed_original_evidence_and_never_enters_model_diagnostic`：真实 HTTP/Host original effect 返回 Unknown；同原 tool 一次 T1、一次 Unknown observation、effect 一次；显式 replan 后仍 typed Unknown/cleanupConfirmed，watch settlement 仍 unknown。没有 root reopen；不额外要求同原 operation 的 late known result。 |
| N2 | `plugins/agent/native/src/owner/tests/computer_native_fence.rs::actual_computer_native_gate_keeps_its_run_fence_across_rebinding_but_not_a_fresh_run`（实际 `owner/tests.rs:34` 注册）：现 Native Fixture/Setup::computer 的真实 Computer catalog、HTTP selected cua_repl/evaluate/Computer result、Host dispatch；局部观察 Handler 从实际 Context 取 production NativeCallContext::Computer 并 bind_original，核原 execution/custody、actual pending T1/code/original RecoveryRef。用 live_access 原 claim 提交 canonical NativeSourceBound/interruption 后，实际 BoundCall 的原 caller 和同 Run 真实 factory 重入新 Arc 均精确 Failed("Native input was physically interrupted in this turn")，guarded_effect callback 与 unused counter 均 0；current/boundary 保持正向；ToolAdmitted/ToolOriginalBound/ChildPrepared/ChildAdmitted 计数 [1,1,0,0] 不增，原 tool/ref 不变。释放原 Handler 后用原 Root.operation(ref).operation_observation 读 Returned Success 内 typed Computer Failed(same message) + CleanupConfirmed；同 Session 真 Host.send fresh Run/new ref 的 current/boundary/native_admission 成功，fresh fence false/old fence true，最终原 model/drained/App shutdown。已亲读全 224 行及 mod。采用 FullAccess 的 boundary-only unit，不启动 SDK VM/OS/page，不构造 opaque source；canonical NativeSource 仅元数据。新 Arc 只证明真实 caller factory 重入不能重置 Run fence。 |

## 原 case 216：completed source / idle Escape / A new VM

原函数：`completed_source_idle_escape_survives_legal_b_then_a_new_vm_but_keeps_browser_and_fresh_turn`。
除显式 assert 外，列出承担行为保证的成功 unwrap，不以它们只是 setup 而漏掉。

| 原断言或成功边界 | 现精确证据及 reader | 判定 / 尚缺 |
| --- | --- | --- |
| A native 和 Cell 已 settle；B native 合法完成后才提交 A late interruption；259 Recorded | D1 原 A Response 后、B 实际 admitted/Bound、释放 A 原 observer，framed ACK + SDK sealed object；S3 terminal old binding 的 canonical native_interrupted | 已有分层断言；D1 是原 observer 已进入而晚 ACK，不是 B 后重新制造旧物理输入。 |
| 260 同一 interruption 再提交返回相同原 receipt | S3 同 binding/FactId 首次 true、重复 false，native_turn_interrupted 原 scope 为 true | 已有 canonical 幂等语义；不保留已退休的 InterruptionCommit 返回类型。 |
| 300 refusal 为已知 Failed，非 Persistence/service retirement | N2 原实际 BoundCall 与同 Run 重入 caller 的 native_admission 精确 Failed(INTERRUPTED)，而 current/boundary 仍成功；原 Root receipt 是 Returned Success 内 typed Computer Failed + CleanupConfirmed | **已有源码断言 / SourceReady**；已知业务拒绝不被冒成 Persistence、service retirement 或原 Root Unknown。 |
| 304 PreparedEffect counter == 0 | N2 guarded_effect 先调用 production native_admission，原 caller/重入 caller 均拒绝；原 callback counter == 0、unused counter == 0 | **已有源码断言 / SourceReady**；不是 sandbox sourcecount == 0，也不声称派发过 OS effect。 |
| 309 no_new_t1(native-a2)，helper 171 验 durable T1 数为 0 | N2 核原 canonical T1/code/ref/admitted/pending，fence 与真实重入前后四 admission 计数仍 [1,1,0,0]，原 tool/original ref 不变 | **已有源码断言 / SourceReady**；只已有外层 T1，不准备/准入新 child，也不绑定新 T1；无 SDK VM 启动声明。 |
| 同一 A grant 下 browser-a 仍准入/settle；并未 Stop 整 Run | S2 fence 后 canonical ComputerApp AppAuthorized 成功、status !stopped（含 rebuild）；N2 同一实际 caller current/boundary 仍正向；D7 独立 execution 的 browser effect scope 保持可用；H1 原 actual-page 生命周期另测 | **原层分解 SourceReady**。旧例只是 append_capability_dispatch + settle，没有 page 对象；不强加同对象 native-fence/page 组合 E2E。S2 不是 SDK BrowserSource，H1 仍是 hardware ignored，不宣称它们连成一次执行。 |
| B 的 native-b2 仍准入/settle | S1 other-session 不 fence；S2 same-presentation different actual Run 的 second 未 fence且新 bind 成功；D1 B 原 Response 保留 | 已有各层 execution 隔离，不声称 OS effect。 |
| A 后续 fresh turn 的 native-fresh 准入/settle | N2 同 Session 真 Host.send，fresh actual Run/new SDK ref；current/boundary/native_admission 均成功，fresh fence false/old fence true；S3 current bind 成功、D9 fresh future 不取消 | **已有源码断言 / SourceReady**；实际 fresh caller 正例，不借 H1 hardware ignored 代签 ordinary unit admission，也不声称真实 native input。 |
| 新 VM epoch-a2 不得绕过 A 原 turn fence | N2 同 Run production native_call factory 重入，Arc 不同但完整 execution 相同，精确 native refusal/counter0；S2 同 Run 新 binding 拒绝；C1 单独验证真实旧/新 kernel retirement ownership | **原层分解 SourceReady**。旧例的 epoch 字符串并非实际 VM；N2 只证明新 caller allocation 不能重置 Run fence，真实 VM 生命周期仍属 C1，不称 N2 启动 SDK VM。 |

## 原 case 382：physical Handoff / reopen / original Unknown

原函数：`late_source_event_after_real_handoff_pause_reopen_fences_its_same_turn_successor`。

| 原断言或成功边界 | 现精确证据及 reader | 判定 / 尚缺 |
| --- | --- | --- |
| 原 native Unknown T2 已写；物理 source sealed 后 437 late interruption 仍 Recorded | S3 terminal old 原 binding 的 canonical late interruption；D1 原 Response 后 A observer 仍完成；S1 在原 Run/rebuild 都未 fence 时，先真实 replacement/核旧票失效与新票 identity，再用原 binding + fresh FactId 首次 native_interrupted 须 true，之后 rebuild 原 Run true/other false且新旧票状态不变 | **已有 after-claim-replacement 原 binding 首次 late interruption 源码断言，已亲读**；不是已 fence 的 duplicate，也不把 replacement 当新 grant。Unknown 保真另由 E2 覆盖。 |
| 452 reopen recover_invocations == 0，不伪造新 recovery outcome | E1 physical retirement 不终结 logical Run，不建 successor，history 跨 reopen 不变；S3 fence rebuild/reopen 不变 | 旧物理 Handoff/recover API 退休，由 stable Run / DriverClaim / Retired 保证替代，不恢复旧实体。 |
| 464 由原 event.id 找回，完整 native_unknown == 原 Unknown（含 message/分类/完整 typed event） | E2 n2 首次 shutdown 前保存原 inline Unknown 完整 RecordedFact/序列化 bytes；reopen 立即及 RiskCancel 后原 fact_barrier 全等，包含 reply.reference/outcome/cleanup；同 tool 原 input ContentRef 对应 bytes 全等，原 T1/effect 不重放 | **已有源码断言，已亲读三处实际 hunk**；对应原完整 event 全等，不要求不存在的 Unknown outputRef，也不把 E3 Returned 冒 Unknown。 |
| 483 successor.turn == source.turn | E1 同 stable Run/turn 的新 claim、单 Run、无物理 successor；S1 新票完整 ExecutionIdentity 等于原 execution | 已有新模型下等价身份约束；不再创建旧物理 successor。 |
| 485 interrupted(native successor)，helper 176 要求 NativeTurnInterrupted | N2 同 stable Run 的实际 caller factory 重入仍精确 Failed(INTERRUPTED)，current/boundary 保持正；S1/E1 的 physical DriverClaim retirement 单独保真 | **已有源码断言 / SourceReady**；不恢复旧 handoff，不用 generic InvalidTransition 冒 native consumer failure。 |
| 499 no_new_t1(successor-native) | N2 原/重入 caller gate 失败后四 admission 计数仍 [1,1,0,0]，原 T1/ref 不改 | **已有源码断言 / SourceReady**；复用同一分支，不重复造物理 successor。 |
| successor-browser 仍准入并 settle | S2 canonical browser-app status/authorization 保留；N2 同一 actual caller current/boundary 仍正向；D7 browser effect scope、H1 actual-page lifecycle 在原层分别保留 | **原层分解 SourceReady**；旧例无 page 对象，不新增同对象 page E2E，不把 ComputerApp 当 SDK BrowserSource。 |

## 原 case 518：forged binding / terminal old turn

原函数：`forged_binding_and_terminal_old_turn_cannot_poison_another_live_turn`。

| 原断言或成功边界 | 现精确证据及 reader | 判定 / 尚缺 |
| --- | --- | --- |
| 546 wrong native epoch 拒 InvalidTransition | D2 outer epoch 与 actual pending identity 不符 Failed，观察者不调用、原 future 不变；正常 inner epoch 映射读 actual sealed source | 已有 SDK 原 wire 层；不要求 inner epoch 等于 outer。 |
| 546 wrong turn 拒绝 | D2 outer/inner turn 负例；S1 canonical wrong turn 拒绝；C4 actual Call policy DTO scope 拒绝 | 已有各层断言，不称跨 crate E2E。 |
| 546 wrong session 拒绝 | D2 outer/inner session 负例；S1 canonical wrong session 拒绝；R2 actual foreign-session custody 拒绝 | 已有精确身份/Root custody 分层断言；不冒 SDK WorkIssuer 全身份测试。 |
| 546 unissued operation 拒绝 | D2 outer/inner operation 和 no-pending 负例；S1 wrong full original RecoveryRef 拒绝；C4 wrong actual operation scope 拒绝 | 已有各层断言。 |
| 554 终态 old 的合法 late event 不毒新 live turn，旧返回 Superseded | S3 old Completed 后 current 已建；wrong attribution 拒绝；合法 old late 留原 scope/current 未 fence，duplicate 幂等，rebuild/reopen 不变 | 已有新语义：合法旧事实保留而非借 Superseded 丢弃；旧返回枚举退休。 |
| live B native 仍可准入/settle | S3 current 新 bind 成功；D2 terminal A 再 Bound 拒绝、B 有效 Bound 和原 Response 不受损 | 已有 canonical + SDK pending/source 分层正例。 |

## 相关生命周期保证：单列而不伪称旧三例已测

| 保证 | 精确证据 | 边界 |
| --- | --- | --- |
| 同 presentation turn、不同 actual Run，不串 fence/cleanup | S2、D1、D7、D9 | S2 真两 canonical Run；D1 真两 admitted SDK invocation。C1 只同 Run 两 VM。 |
| OldSource late ACK 不能退休 replacement source | D6 | 原 NativeOwner actual source Arc / 原 framed control ACK / B-C 原结果；Windows/native-desktop，不是 SQLite。 |
| 原 producer EOF/drained 与原 observer 完成相互不冒充 | D3、D4、D1 的 B drain/原 Response/late drain 拒绝 | D4 Linux owned child，不是物理 key。 |
| 原 writer/fork pins 必须真实关闭，不能新 reader 冒 late ACK | R1 | 两原 custody/writer、原 fork/retention token、各自 settlement；不声称 Agent/SDK 复合证明。 |
| 实际 Computer source_lease 完成后释放 | C2 | await 原 cleanup 后 lease None；未绑定 opaque NativeSource，不能冒 D6 的晚 ACK。 |
| 新 VM 不被旧 VM retirement 清掉 | C1 | await 原 old epoch/observer，验证 replacement gate/receipt；不是 NativeSource 新旧 ACK。 |
| 真实 SDK WorkIssuer/full execution 验伪 | C0 / R2 只证明各自实际 provenance 和 Root custody 负例；D8 只 browser scope | 尚未找到可单列此名称的完整测试证据；不把 production 检查或元数据 NativeSource DTO 当证明。 |

## Source readiness 与退休范围

原三例逐断言现均有上述原层的明确源码映射，不再有未闭合的旧 ledger 保证。最后的 actual BoundCall gate 缺项由 N2 补齐；browser/page 与真实 VM 生命周期按旧基线分层，不增加同对象 page E2E 或 SDK VM 启动门槛。父任务已亲核并正式授权本会话删除旧 Root Rust 实体，保留本表；main 的旧 mod 由父任务 sole 配对移除。未运行任何检查，不以 SourceReady 宣称通过。

## 已闭合或不新增的边界

- S1 已补真实 same-Run replacement 之后的首次原 binding late interruption：replacement 前始终未 fence，之后 fresh FactId 首次提交 true，再 rebuild 原 scope fence/other scope 不 fence，旧票仍 superseded、新票完整 execution 不变。eeb 原 owner 已交回 freeze，本表作者已亲读该有限末 hunk；SourceReady，不是执行通过。
- E2 n2 的 inline Unknown 原完整 RecordedFact/序列化 bytes 在 reopen 立即及 RiskCancel 后全等，原 reply.reference/分类不改；同 tool 已有 input ContentRef/bytes 保真，不重放。父任务 sole 补充已 source-ready，本表作者已亲读；未编译或执行。旧 382 没有同 call 的 late KnownToolResult：423 settle 的是 Cell，后续 504/512 成功的是另一 operation successor-browser；因此不新增 Unknown→Returned 或独立 late-known-fact 门槛。
- SDK WorkIssuer 全身份验伪不冒称已有，也不把它作为超出旧 ledger 基线的新删除门槛。C0/R2/D8 分别只证明表中已写明的实际 provenance、Root custody 和 browser effect scope。

只在对应原层、原 case 的明确 hunk lease 下补必要断言。
SDK01 已补 D1/D2，State owner 已补 S1，05a 原 owner 已补 N2；本表作者只亲读和更新映射，未并写其冻结源码。
仅退休旧 Root 三例实体及其父任务管理的注册，不删除其他 Root 保证；不新增 Computer mod、target、feature、public hook、fake Role 或跨 cfg(test) type bridge。

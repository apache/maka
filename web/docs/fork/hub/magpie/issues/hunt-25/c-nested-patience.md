gateway: 内层组的 Patience（"Every member busy" 等待预算）经外层组请求时从不被读——嵌套组家族同款（#2246/#2255/#2259）

## 现象

嵌套组里，内层组自己设置的 Patience（组编辑器 "Every member busy" 一行）永远不生效：请求经外层组进来时，重试预算只来自外层组。两个方向都会发生：

- 内层 4 min、外层默认 1 min：用户给内层组设的"等 4 分钟"，实际 1 分钟就把错误给了 agent——#1418（real-jacket 的 patience=240 提前放弃）在嵌套一层后原样复现。
- 内层 Off、外层默认：内层成员全忙时仍被反复重问 60 秒，内层组的"立即把错误给 agent"也失效。

编辑器对嵌套组渲染同一行设置（`internal/gui/assets/plugins/routing/client.js:4538` 的 "Every member busy"），字段可设、无处消费。

## 最小复现

两个假厂商永远回 529 `server_is_overloaded`；组 `In`（a/m, b/m，In order，Patience=8）、组 `G`（group/in，In order，Patience=3）；`retryPause = time.Second`（与生产一致，参照 `patience_test.go:17`）。完整测试在文末，可直接放进 `internal/gateway` 跑。

| 请求 | 尝试次数 | 下一轮 replan | trace 的 Patience | 耗时 |
|---|---|---|---|---|
| 直接 `group/in` | 3 次（初始 + 2s、4s 两轮重问，6s < 8s 预算内；第三轮 8s 停顿会越过 8s 被拒） | 2 轮 | 8 | ~6s |
| 经 `group/g` | 2 次后就停（2+4=6s > 外层 3s） | 1 轮 | **3** | ~2s |

关键对照：经外层时第二轮 replan 在 6s 处被拒（6 > 3），而内层组自己的 8s 预算明明允许它（6 < 8）——内层的 8 没有被任何人读。0.1.1244（4a6bf80f）、dcf292cc 与发帖前 tip（2e2c8903）行为一致。#1421 的可配置重试预算是新能力，本帖说的是现有 Patience 字段已承诺的语义在内层组上就缺着。

## 根因

`internal/gateway/gateway.go:2177-2181`：

```go
// a group's members that failed in a way that passes are asked again,
// once each has been, for up to its Patience (#1418)
var patience time.Duration
if isGroup {
    patience = g.Waits()
}
```

这是请求路径上 Patience 的唯一消费点（全仓 `Waits()` 调用只有这一处），而 `g` 自始至终是请求点名的那个组（`provider.FindGroup(asked)`）。`planLevel` 递归进内层组时（`fallback.go:446`）没有把内层的 Patience 带出来——`candidate` 上有 `firstToken`（#2246）和 `affinity`（#2259），没有 patience。直接请求 `group/in` 时 `g` 恰好就是内层组，所以单看内层一切正常：就是 #2246 说的"knob works, it is just wired to the wrong group"。

## 修法建议

与已合并的 #2246/#2255/#2259 同一条规则——内层组设了就以它的为准，没设落回点名的组：

1. `candidate` 增加 `patience int`：`innerPatience(m)`，`m.Via` 自内向外第一个设了 Patience 的组（同 `innerFirstToken`，`fallback.go:398` 的结构）。
2. replan 预算按成员算：`busyNow` 里的每个成员按自己的预算算截止（`waitFrom.Add(成员自己的 Waits())`），预算花完的成员退出下一轮 `next`，只要还有成员有剩余预算循环就继续；内层 Off（-1）的成员不参与 replan。`replan` 的 `by` 从单一 deadline 变成按成员判断（`patience.go:73`）。
3. `holdWriter` 的保留条件（`gateway.go:2232`）与 trace 的 `try.Patience` 取"当前成员的预算"与"还有剩的成员的最大预算"。

如果维护者认为"Patience 属于请求，归点名的组"是有意设计，请直接关闭，并建议在 `docs/subsystems/gateway-routing.md` 补一句——Sink（#2255）、FirstToken（#2246）、Affinity（#2259）三行都写了内层组语义，唯独 Patience 没有对应说明，读文档的人会以为它也按内层生效。

## 复现测试

```go
var hunt25Overloaded = reply{529, "", `{"error":{"message":"Our servers are currently overloaded. Please try again later.","code":"server_is_overloaded"}}`}

func hunt25PatienceSetup(t *testing.T) (*scripted, *scripted) {
	t.Helper()
	k := retryPause
	retryPause = time.Second
	t.Cleanup(func() { retryPause = k })
	a := &scripted{replies: []reply{hunt25Overloaded, hunt25Overloaded, hunt25Overloaded, hunt25Overloaded}}
	b := &scripted{replies: []reply{hunt25Overloaded, hunt25Overloaded, hunt25Overloaded, hunt25Overloaded}}
	scriptedOn(t, "a", provider.Chat, a)
	scriptedOn(t, "b", provider.Chat, b)
	if err := provider.SaveGroup(provider.Group{Name: "In", Members: []string{"a/m", "b/m"}, Routing: provider.Ordered, Patience: 8}); err != nil {
		t.Fatal(err)
	}
	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"group/in"}, Routing: provider.Ordered, Patience: 3}); err != nil {
		t.Fatal(err)
	}
	return a, b
}

func TestNestedGroupPatienceThroughOuter(t *testing.T) {
	fresh(t)
	a, _ := hunt25PatienceSetup(t)
	code, _ := postAs(t, New(), "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`)
	if a.n != 2 { // 内层自己的 8s 预算本允许第二轮（6s < 8s）
		t.Fatalf("asks: a.n=%d, want 2 — the inner group's own 8s budget was not read", a.n)
	}
	if code != 529 {
		t.Fatalf("code=%d", code)
	}
}
```

## 验证

| 检查 | 结果 |
|---|---|
| `TestHunt25InnerGroupPatienceDirect`（对照组：直接问内层） | PASS：a.n=3，trace `patience=8`，`again=2000ms`、`again=4000ms` 两轮 |
| `TestHunt25InnerGroupPatienceThroughOuter` | PASS：a.n=2，trace `patience=3`，一轮后停 |
| 上述测试在 dcf292cc、2e2c8903（发帖前 tip）重放 | 行为一致（through-outer 版：a.n=2，patience=3） |
| `go vet`/构建套件 | 未跑——本帖只报现象与复现，未改产品代码 |

Generated-by: GLM-5.3-Flash (ZCode)

---

## 复现原始输出（2e2c8903，macOS，go1.26.8）

```
=== RUN   TestHunt25InnerGroupPatienceDirect
    direct: code=529 a.n=3 b.n=3 took=6.024460125s
      try: status=529 fail=other again=0ms replan=0 patience=0
      try: status=529 fail=other again=2000ms replan=2 patience=8
      try: status=529 fail=other again=0ms replan=0 patience=0
      try: status=529 fail=other again=4000ms replan=2 patience=8
      try: status=529 fail=other again=0ms replan=0 patience=0
      try: status=529 fail=other again=0ms replan=0 patience=0
--- PASS: TestHunt25InnerGroupPatienceDirect (6.68s)
=== RUN   TestHunt25InnerGroupPatienceThroughOuter
    through outer: code=529 a.n=2 b.n=2 took=2.027519667s
      try: status=529 fail=other again=0ms replan=0 patience=0
      try: status=529 fail=other again=2000ms replan=2 patience=3
      try: status=529 fail=other again=0ms replan=0 patience=0
      try: status=529 fail=other again=0ms replan=0 patience=0
--- PASS: TestHunt25InnerGroupPatienceThroughOuter (2.07s)
```

测试文件留在 worktree /tmp/magpie-hunt25-c/internal/gateway/zz_hunt25_patience_repro_test.go（未提交、未推分支；issue 正文含可独立落盘的测试）。

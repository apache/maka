# 新发现（登记不发）：remote magpie 的 key-limit 429 头在 relay 路线丢失，#2077 的"整 remote rest/sink"按线不可达

日期：2026-10-18；审计基线 upstream/main @ d783df46；本文件只登记，不修不发。

## 形状

`remoteModelRest`（internal/gateway/routing.go，d53a51cd #2077 引入 header 参数）靠
`header.Get("X-Magpie-Limit-Reset")` 区分 remote 的 key 自身限额（rest 整 remote）与
模型级拒答（rest 单模型）。但该头从 upstream 响应到 `restAfterMarked` 的 `header`
参数之间被丢：

- `attempt` 的失败出口（gateway.go:4487）只经 `keepRetry`（routing.go:1030）复制
  `retry-after` 与含 `ratelimit…reset` 的头；`X-Magpie-Limit-Reset` 不在白名单。
- `restAfterMarked` 收到的是 `hw.header`（holdWriter 自建空 Header，gateway.go:2327、
  fallback.go:1662），upstream 原始响应头不进它。
- 全仓 `remoteKeyLimitHeader` 的写点只有本地 `keyLimited`（key_limit.go:64，写给
  magpie 自己的客户端）；`remoteModelRest`（routing.go:950）是唯一读点，读的是
  relay 后的 hw.header——永远为空。

## 实测证据（stderr 探针，临时改 routing.go 后复跑，已还原）

夹具：Remote magpie provider `office`（glm/glm-5、kimi/kimi-k3），假上游对 glm 回
429 + `X-Magpie-Limit-Reset` + `Retry-After: 60`，Ordered+Sink 组 [glm, kimi, other/m]。

```
DEBUG restAfterMarked why=rate remoteMR=true restKey="office" restID="office/glm/glm-5" chosen="office/glm/glm-5" hdr=
```

`hdr=` 为空 → `remoteModelRest` 走 true 分支 → rest 落 `office/glm/glm-5`（模型级），
kimi 下次请求照常被问。`Retry-After` 同问到达（rest 60s 生效），证明头确实 selective copy，
不是整体丢失。消费该头的 d53a51cd 单元测试（TestRemoteMagpieKeyLimitRestsTheKey）
用手工构造的 `http.Header{}`，看不见传输丢失；#2077 的 e2e 测试（嵌套真网关）只测
模型级拒答路径，未测 key-limit 路径——与本路 10-14 对该测试的 P3 批评一致。

## 对 #2167 patch 的影响

patch 的 sink 分支复用同一谓词：线上 key-limit 429 同样沉 restID（模型级），
"key-limit 沉整个 remote"的 #2077 语义在传输层同样不可达。patch 逻辑本身与 rest
作用域一致、不引入回归（消融与家族回归全绿），缺陷属 #2077 面，不并入本单。

## 可选修法（留给新单，一行）

`keepRetry` 的白名单加 `l == "x-magpie-limit-reset"`（或把 remoteKeyLimitHeader
显式带上），随后 e2e 钉子（`TestRemoteMagpieKeyLimitSinksTheRemote`：断言请求 2
remote 两模型都在 other 之后、`asked==[]`）可转绿。证据测试全文见本文件末尾。
另一条路是维护者裁决接受 key-limit 也按模型级 rest/sink（行为与现状线上一致），
那就是撤 d53a51cd 的 header 机制而非修传输。

## 证据测试（基 d783df46 + #2167 patch，修前红；修 keepRetry 后预期绿）

```go
// The key's own limit on the other magpie (the X-Magpie-Limit-Reset its
// keyLimited answers with, #2077) is the key's whatever model it was asked
// for, and the sink keeps that scope: the whole remote goes behind the
// next member, the limited model and the one with quota left together —
// the opposite of a plain 429, which sinks the model alone
// (TestRemoteMagpieRateLimitSinksTheModel).
func TestRemoteMagpieKeyLimitSinksTheRemote(t *testing.T) {
	fresh(t)
	forgetSinks(t)
	var mu sync.Mutex
	var asked []string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		asked = append(asked, req.Model)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if req.Model == "glm/glm-5" {
			w.Header().Set(remoteKeyLimitHeader, "2026-10-19T00:00:00Z")
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"error":{"message":"gateway key over its request budget"}}`)
			return
		}
		io.WriteString(w, `{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"from `+req.Model+`"},"finish_reason":"stop"}]}`)
	}))
	t.Cleanup(remote.Close)
	if err := provider.Save(provider.Provider{ID: "office", Name: "Office", Preset: provider.RemoteMagpiePreset, Key: "k",
		Chat: remote.URL + "/v1", Models: []string{"glm/glm-5", "kimi/kimi-k3"}}); err != nil {
		t.Fatal(err)
	}
	other := &keyed{}
	serveOn(t, "other", "ko", []string{"m"}, other)
	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"office/glm/glm-5", "office/kimi/kimi-k3", "other/m"}, Routing: provider.Ordered, Sink: true}); err != nil {
		t.Fatal(err)
	}
	s := New()
	// glm's key limit there: the turn goes on to kimi this once, and the
	// whole remote rests after it, not glm alone
	if code, body := postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`); code != 200 || !strings.Contains(body, "from kimi/kimi-k3") {
		t.Fatalf("glm's key limit on the remote: %d %s", code, body)
	}
	if _, ok := restOf("office"); !ok {
		t.Errorf("the key's own limit there didn't rest the remote whole: %v", rests())
	}
	// asked again, the remote's both models are behind other — the rest
	// and the sink hold them together, kimi never asked
	mu.Lock()
	asked = nil
	mu.Unlock()
	if code, body := postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`); code != 200 || !strings.Contains(body, "from m") || len(asked) != 0 {
		t.Fatalf("the remote's models were asked %v after its key limit: %d %s", asked, code, body)
	}
}
```

修前实测失败（基 d783df46 + #2167 patch，`go test -tags nogui -count=1 -run TestRemoteMagpieKeyLimitSinksTheRemote ./internal/gateway/`，exit 1）：

```
    remote_magpie_rest_test.go:185: the key's own limit there didn't rest the remote whole: map[office/glm/glm-5:2026-10-18 11:54:36.019161 +0800 CST m=+60.168154001]
    remote_magpie_rest_test.go:187: DEBUG rests=map[office/glm/glm-5:...] office/glm=true office/kimi=false
    remote_magpie_rest_test.go:194: the remote's models were asked [kimi/kimi-k3] after its key limit: 200 {"...content":"from kimi/kimi-k3"...}
```

## 不自信清单

- 夹具的假上游是手工 httptest handler，非嵌套真网关；真两机部署是否有别的头传递路径未实测（读码未找到）。
- `keepRetry` 一行修会改变所有 429 的头复制白名单（含非 remote provider），是否被维护者接受属裁决区。
- 未验证：`restAfter`（gateway.go:1316，直接收 `res.Header`）路径是否覆盖部分场景使缺陷面变小；该路径不在 group failover 主链上，但未逐点排查。

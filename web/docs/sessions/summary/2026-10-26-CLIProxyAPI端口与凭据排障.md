# CLIProxyAPI 端口与凭据排障

**一句话总结**：codex 连不上本地 CLIProxyAPI，是两个独立问题叠加——客户端与服务端端口错位（8317/8318），加上凭据文件躺在历史遗留位置且不能放子目录，逐层定位后统一端口、平铺凭据解决。

## 背景

codex 走本地 CLIProxyAPI 代理（127.0.0.1:8317）先报 502，把端口统一后又报 `unknown provider for model gpt-5.6-luna`。排查发现报错其实来自代理本身：认证目录里一个凭据都没加载到，23 个 codex OAuth 账号文件遗留在代理工作目录的 `.cli-proxy-api/free/` 下。

## 核心命令

```bash
# ── 端口排查三件套：配置端口 / 实际监听 / 探活 ──
grep -n "port" <服务目录>/config.yaml
# 看服务声明的端口

netstat -ano | grep ":8317" | grep LISTEN
# 看端口实际谁在听，末列是 PID；无输出 = 没进程在听

curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8317/v1/models
# 探活只看状态码：200 = 通，000 = 连不上

# ── 查某个 PID 的完整启动命令（确定服务怎么起的、用哪个配置）──
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<PID>' | Select-Object -ExpandProperty CommandLine"

# ── 重启本地 exe 服务（Git Bash 下 taskkill 参数要用双斜杠）──
# ⚠️ taskkill //F 是强制杀进程，先 netstat 确认 PID 确实是目标服务再动手
taskkill //PID <PID> //F
powershell -NoProfile -Command "Start-Process -FilePath 'cli-proxy-api.exe' -ArgumentList '--config','.\config.yaml' -WorkingDirectory '<服务目录>'"

# ── 只看 JSON 字段名不看值（查凭据/配置结构，token 不会打印到终端）──
python -c "import json; d=json.load(open(r'<文件>', encoding='utf-8')); print(list(d.keys()))"

# ── 全盘找错位存放的凭据/配置目录 ──
find <数据盘> -maxdepth 6 -type d \( -name "auths" -o -name "free" \)
# 注意 maxdepth 要给够：目标在更深层级时浅深度会静默漏掉

# ── 验证代理暴露的模型列表 ──
curl -s http://127.0.0.1:8317/v1/models | python -c "import json,sys; d=json.load(sys.stdin); print([m.get('id') for m in d.get('data',[])])"

# ── 端到端最小验证（Responses API 的 input 可直接给字符串）──
curl -s -X POST http://127.0.0.1:8317/v1/responses -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","stream":false,"input":"Reply with exactly: ok","max_output_tokens":16}'
# 返回 "status":"completed" 即链路全通
```

## 关键结论

1. **报错先分清客户端还是服务端**。`unknown provider for model` 看着像 codex 配置问题，实际是 CLIProxyAPI 返回的 400 `model_not_found`。代理错误日志（`auth-dir/logs/error-v1-responses-*.log`）记着完整请求头、请求体和响应，先翻日志再猜，一步定位。

2. **CLIProxyAPI 8.0.35 不递归扫描 auth-dir**：凭据 json 必须平铺在 auth-dir 根目录，放进子目录会被静默忽略（`/v1/models` 返回空列表），`.cds` 冷却文件同样放根目录旁边。改 auth-dir 内容支持热加载，几秒内生效不用重启；只有改端口这类启动参数才需要重启进程。

3. **凭据"丢失"先查代理工作目录下的 `.cli-proxy-api/`**。老版本用相对路径 auth-dir 时会把凭据写歪到工作目录这里（配置文件注释里写明的历史坑），换绝对路径后旧文件不会自动迁移，需要手动平铺复制到新 auth-dir 根目录。

4. **模型列表按 provider 去重**：1 个账号和 23 个账号暴露的 `/v1/models` 完全一样，账号是容量冗余不是模型增量。验证凭据是否加载成功，放一个账号文件进根目录看模型数变化即可，不用全量搬。

5. **迁移账号池前先算收益**：magpie 不支持导入 CPA 的 OAuth 凭据 JSON（订阅类 token 只能在 magpie 里逐个浏览器 OAuth 登录，它的导入功能只读 API key 类配置）。为省掉 localhost 一跳（毫秒级延迟）迁移 23 个账号，还要放弃 CPA 的池化调度和冷却机制，不划算——已跑通的链路维持现状。

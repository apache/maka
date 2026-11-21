## 问题

Magpie 开启内置隐私脱敏时，历史工具调用的 `function.arguments` 中如果包含换行后紧接 Python 装饰器的代码，例如 `\n@mcp.tool()`，请求会被 Ollama Cloud 以 `invalid tool call arguments` 拒绝。

客户端发送的外层请求和内层 `arguments` 均为有效 JSON。同一条工具调用直接发送到 Ollama Cloud 可以成功；只把内层 JSON 中的 `@` 改写为等价的 `\u0040`，经过 Magpie 也能成功。两种 arguments 的 JSON 解析结果完全一致。

这会使已有长会话持续失败：即使下一轮没有产生新工具调用，重放该历史记录仍然返回 400。

## 环境

- Windows，Magpie **0.1.1294**。
- 客户端：DeepSeek Harness；下方脚本直接调用网关即可复现，不依赖客户端。
- 接口：OpenAI Chat Completions，`POST /v1/chat/completions`。
- 上游：Ollama Cloud，`deepseek-v4.1-flash:1017`。
- `redact: true`、`redactPersonal: true`；复现不依赖自定义脱敏词。
- 2026-10-20 重新实测。

## 最小复现

在网关配置好 Ollama Cloud，保持隐私脱敏开启。设置 `MAGPIE_KEY` 为本机网关 key 后运行以下 Python 脚本（仅标准库）。

这是合成的历史调用，**不会执行任何工具**，也不需要原会话。

```python
import json
import os
import urllib.error
import urllib.request

base = os.environ.get("MAGPIE_BASE_URL", "http://127.0.0.1:3425/v1")
model = os.environ.get("MAGPIE_MODEL",
                       "ollama-cloud/deepseek-v4.1-flash:1017")

command = "print('before')\n@mcp.tool()\ndef demo():\n    return 1"
original = json.dumps({"command": command})
escaped = original.replace("@", r"\u0040")
assert json.loads(original) == json.loads(escaped)

for label, arguments in [
    ("plain_decorator", original),
    ("equivalent_unicode_escape", escaped),
]:
    payload = {
        "model": model, "stream": False, "max_tokens": 32,
        "messages": [
            {"role": "user", "content":
             "Diagnostic: historical tool already completed. "
             "Reply OK; do not call tools."},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_repro", "type": "function",
                "function": {"name": "pwsh", "arguments": arguments}
            }]},
            {"role": "tool", "tool_call_id": "call_repro",
             "content": "Completed."},
            {"role": "user", "content": "Reply OK."},
        ],
    }
    request = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + os.environ["MAGPIE_KEY"],
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
            print(label, response.status,
                  data["choices"][0]["finish_reason"])
    except urllib.error.HTTPError as error:
        data = json.load(error)
        message = data.get("error", {}).get("message", "")
        print(label, error.code, message.split(" (ref:")[0])
```

本机实测输出：

```text
plain_decorator 400 Ollama Cloud: invalid tool call arguments
equivalent_unicode_escape 200 stop
```

## 对照结果

| 输入 / 路径 | 结果 |
|---|---|
| 原会话最后一条历史工具调用，经 Magpie | HTTP 400 |
| 同一条历史调用，直连 Ollama Cloud | HTTP 200 |
| 合成最小案例 `\n@mcp.tool()`，经 Magpie | HTTP 400 |
| 相同案例，仅将 arguments 的 `@` 编码为 `\u0040`，经 Magpie | HTTP 200 |
| 将原会话内 8 条受影响历史调用做上述等价编码后，经 DeepSeek Harness → Magpie → Ollama Cloud 诊断重放 | HTTP 200，模型回复 `OK` |

验证时保留了隐私脱敏设置。原会话文件未修改。

## 定位线索

从上述差分结果以及当前源码判断，问题在于把**已经序列化的内层 JSON 字符串**作为普通文本扫描，而没有保护它的转义边界：

- [EMAIL 规则](https://github.com/yetone/magpie/blob/588f87a126834c2ed1c6348a35c6f031924c1855/internal/redact/redact.go#L133) 可以把 `\n@mcp.tool()` 中反斜杠后面的 `n@mcp.tool` 当作邮箱。
- [MaskJSON 的字符串处理](https://github.com/yetone/magpie/blob/588f87a126834c2ed1c6348a35c6f031924c1855/internal/redact/json.go#L385) 将解码后的外层字符串直接交给 `mask(s, o, put)`。对于 `function.arguments`，该字符串本身仍然是一份内层 JSON。
- 如果匹配从 `\n` 的 `n` 开始，替换后原来的反斜杠将留在占位符前，造成内层 JSON 非法。外层 JSON 仍可正常解析，所以错误最终表现为上游的工具参数校验失败。

上述内部匹配过程是结合源码的定位分析；本报告没有附加或声称抓取到完整上游原始请求。

相关但不同的问题：#1911 涉及自定义脱敏词破坏 Lark grammar；本 issue 涉及内置邮箱规则破坏**历史工具参数的内层 JSON 转义**。

## 期望与修复建议

脱敏后，所有原本有效的 `tool_calls[].function.arguments` 仍应是有效 JSON；Python 装饰器不应被视为邮箱。

建议在保留真实敏感数据脱敏的同时：

1. 在协议中明确识别装载 JSON 的字符串字段，对内层 JSON 的字符串值进行结构化脱敏，再重新序列化，避免替换跨越转义边界。
2. 补充 `\n@mcp.tool()`、`\r\n@mcp.tool()`、多个装饰器、Windows 路径及真实邮箱与装饰器混合的回归案例。
3. 回归测试同时验证外层 JSON 和每个原本有效的 arguments JSON，防止仅外层通过。

本地临时兼容方法是只在发送请求时，对换行后紧接装饰器的 `@` 采用等价 Unicode 转义，且验证改写前后的 JSON 解析结果相等；无需关闭整个隐私脱敏功能。这可以恢复会话，但仍需要在 Magpie 的脱敏层修复。


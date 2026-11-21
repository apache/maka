# 4432 RED/GREEN 原始输出（逐字留档）

## RED（修复前，分支父提交 a8e98e1ab 语义）

命令：
cd /tmp/mg115-c && GOTOOLCHAIN=auto go test ./internal/gateway/ -run 'TestRelayDrawsTheGPTImageFamilyByItsBareName|TestCodexNativeDrawsItsOwnModelOnARelay' -count=1

输出：
--- FAIL: TestRelayDrawsTheGPTImageFamilyByItsBareName (0.09s)
    drawing_resolve_test.go:142: 404 {"error":{"code":null,"message":"magpie knows no model \"gpt-image-2\" to draw with","param":null,"type":"not_found_error"}}
--- FAIL: TestCodexNativeDrawsItsOwnModelOnARelay (0.04s)
    drawing_resolve_test.go:166: 200 {"created":1793567041,"data":[{"b64_json":"iVBORw0KGgogZmFrZQ==","mime_type":"image/png"}],"model":"relay/gpt-image-2.5-flare","usage":{"input_tokens":7,"output_tokens":100,"total_tokens":107}}
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.134s

- 测试 1 = 报告者截图错误逐字复现（404 magpie knows no model "gpt-image-2" to draw with）。
- 测试 2 = 覆盖实锤：codex 要 gpt-image-2，magpie 200 返回自己的 pick（relay/gpt-image-2.5-flare）。

## GREEN（修复后，commit 4ff4f57e4）

命令：同上

输出：
ok  	github.com/yetone/magpie/internal/gateway	1.056s

## 消融（checkout HEAD~1 -- internal/gateway/draw.go，仅回退产品文件）

--- FAIL: TestRelayDrawsTheGPTImageFamilyByItsBareName (0.22s)
    drawing_resolve_test.go:142: 404 {"error":{"code":null,"message":"magpie knows no model \"gpt-image-2\" to draw with","param":null,"type":"not_found_error"}}
--- FAIL: TestCodexNativeDrawsItsOwnModelOnARelay (0.06s)
    drawing_resolve_test.go:166: 200 {"created":1793567318,"data":[{"b64_json":"iVBORw0KGgogZmFrZQ==","mime_type":"image/png"}],"model":"relay/gpt-image-2.5-flare","usage":{"input_tokens":7,"output_tokens":100,"total_tokens":107}}
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	2.395s

变异点 = drawsFamily 的 switch 少一个 case；恢复后转绿。

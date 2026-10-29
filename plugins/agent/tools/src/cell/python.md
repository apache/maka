Orchestrate tool calls in a fresh Monty Python interpreter. Use Python source with top-level await. Supported standard-library modules include asyncio, json, re, math and collections; installing packages, native extensions, direct filesystem/network access and subprocesses are unavailable. Use authorized Host tools for external work.
Pass raw Python on freeform transports; on JSON-only transports put the same source in code. Optional first line: # @exec: {"yield_time_ms": 30000, "max_output_tokens": 10000}
Call await tools.name(input), with a JSON-compatible value, or await tools.name(**kwargs) for an object input. Names are normalized Python identifiers. Await every intended operation. Use import asyncio and await asyncio.gather(...) for parallel calls. To collect partial failures, wrap each awaited call in try/except and return an explicit success/error value. Monty supports asyncio.run/gather/sleep; create_task, wait_for, TaskGroup and gather(return_exceptions=True) are unavailable. When source finishes, unawaited operations are cancelled; admitted Host effects still settle before completion.
Helpers:
- text(value): emit a string or JSON value. Final expressions and print() do not publish output.
- image(value, detail=None): emit a Host image, MCP image block or base64 data URL; image_url objects are accepted. detail is auto/low/high/original; an explicit argument overrides embedded detail.
- audio(value): emit an MCP audio block, audio_url object or base64 data URL. Audio is delivered as native model input when supported; unsupported adapters receive an explicit notice.
- generated_image({"image_url": ..., "output_hint": ...}): emit an image and optional hint.
- store(key, value), load(key): retain JSON between exec calls in this live session, including across turns and compaction. Missing keys return None. No Python globals survive. Writes publish after settlement. Host restart/session retirement clears the store.
- notify(value): inject output into model history without wait, yielding or finishing the cell. Notifications during a model request arrive on the next step.
- await yield_control(): return accumulated output while the cell continues.
- exit(): end the script successfully.
- ALL_TOOLS: tuple of immutable name/description records for all authorized nested tools, including deferred tools omitted from this description. Find a tool here and call it in the same cell.
Only JSON values cross the Host boundary: object keys must be strings; bytes, sets, cycles, non-finite floats and integers outside the JSON integer range are rejected. Convert intentionally inside Python before calling tools or output/store helpers.
Use wait only after exec returns a running cell_id. Tool permissions and schemas stay frozen for the cell. Calls to other advertised tools must be made directly. Do not invoke exec in parallel with other model tools.
Host execution: 64 MiB interpreter allocation budget in an isolated worker with allocator headroom, 30 seconds cumulative execution (Host waits and sleeps excluded). Tool work remains owned until cleanup; use wait to collect running cells.

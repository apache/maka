# WP6 · Python 任务重启修复（独立，可随时合并）

**目标**：修复 A-P0-2。服务重启后在途任务永远卡在 `running`，并修掉 `tasks.py:68` 的判断错误；后台协程加强引用（A-P1-4）。与智能体迁移无关，可最先合并。

**依赖**：无（WP0 之前也可以做）。**分支**：`fix/wp6-task-restart`

## 现状证据

- `tasks.py:68` `if task.status not in _TASKS:`：拿状态值和 taskId 键比较，恒为真，等于没有去重。本意是 `task.taskId not in _TASKS`。
- `restore_snapshots()` 只把快照读回内存，**不重新调度** `_run`。快照里 `queued` / `running` 的任务重启后永远不再推进，前端会一直轮询下去。这和模块文档"重启可恢复在途任务"的承诺不符。
- `tasks.py:115` `asyncio.create_task(_run(task_id))` 不保存引用。按 asyncio 文档，任务可能在执行中被 GC 回收。

## 归属文件

`apps/api/app/tasks.py`、`apps/api/tests/test_tasks.py`

## 设计

1. 去重条件改为 `task.taskId not in _TASKS`。
2. 恢复语义：**续跑**，兑现文档承诺。
   - `queued` / `running` 的任务恢复后重新调度 `_run(task_id, resume=True)`；
   - `_run` 在 `resume` 时接受 `RUNNING` 状态，从 `progress // 10 + 1` 这一步继续；
   - 若续跑时抛异常，沿用现有兜底，置 `failed`。
   - 备选：直接判 `failed` 并给出 `failReason="服务重启，任务已中断，请重试"`。实现更简单，但违背"可恢复"的产品承诺，只作为异常兜底。
3. 强引用：`_BACKGROUND: set[asyncio.Task] = set()`；`t = asyncio.create_task(...)`；`_BACKGROUND.add(t)`；`t.add_done_callback(_BACKGROUND.discard)`。
4. `restore_snapshots()` 在 lifespan 中调用，此时已有事件循环，可以直接 `create_task`。为了让单测能同步调用，提供 `schedule: bool = True` 参数。

## 测试（先红）

1. 写一个 `running` 且 `progress=40` 的快照到临时 `AGENT_HUB_SNAPSHOT_DIR` → 调用恢复 → 最终状态为 `completed`（或确定性失败的 `failed`），progress 从 40 继续增长而不是归零。
2. 同一 taskId 的快照不会重复载入（回归 `:68`）。
3. `create_task` 后 `_BACKGROUND` 含该任务，完成后移除。
4. 已 `completed` / `archived` 的快照恢复后不被重新调度。

## 验收

- `pnpm test:api` 全绿，原 29 个测试不改。
- 手测：创建任务 → 进度到一半时重启 API → 刷新页面 → 任务继续，最后出现"浇水"段落。

## Cursor 提示词

```text
仓库 agent-hub，分支 fix/wp6-task-restart（从 main 拉）。
目标：修复 apps/api/app/tasks.py 的重启恢复：(1) 第 68 行 if task.status not in _TASKS 应为 task.taskId not in _TASKS；(2) restore_snapshots 只读回内存不重新调度，queued/running 任务重启后永远不推进——改为续跑；(3) asyncio.create_task 未保存引用，可能被 GC。
先读：AGENTS.md、工作包/WP6、tasks.py、tests/test_tasks.py、main.py 的 lifespan。
步骤：
1. 先在 tests/test_tasks.py 追加用例（用 monkeypatch 设置 AGENT_HUB_SNAPSHOT_DIR 为 tmp_path、TICK_SECONDS 调小）：running+progress=40 的快照恢复后续跑到 completed/failed，且 progress 不归零；同一 taskId 不重复载入；create_task 后后台集合持有任务、完成后移除；completed/archived 快照不被调度。先确认失败。
2. 修改 tasks.py：去重条件用 taskId；新增 _BACKGROUND 集合与 _spawn() 帮助函数（add + add_done_callback(discard)）；_run(task_id, resume=False) 在 resume 时接受 RUNNING 并从 progress//10+1 步继续；restore_snapshots(schedule=True) 对 queued/running 调 _spawn(_run(id, resume=True))。
硬约束：不改 TaskSnapshot 契约与 HTTP 接口；不加依赖；不引测试框架；原有测试一行不改；pnpm test:api 全绿。
完成后输出：改动文件、测试结果、重启续跑的手测步骤与结果。
```

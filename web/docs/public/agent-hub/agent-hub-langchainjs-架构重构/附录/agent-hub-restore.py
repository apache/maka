import asyncio, os, sys, tempfile
os.environ["AGENT_HUB_SNAPSHOT_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, "/data/repos/agent-hub/apps/api")
from app import tasks
async def main():
    t = await tasks.create_task()
    await asyncio.sleep(1.0)                       # 跑到 running 中途
    print("重启前:", tasks.get_task(t.taskId).status, tasks.get_task(t.taskId).progress)
    for at in asyncio.all_tasks():                 # 模拟进程被杀：后台协程消失
        if at is not asyncio.current_task(): at.cancel()
    tasks._TASKS.clear()
    print("restore 计数:", tasks.restore_snapshots())
    await asyncio.sleep(5)                         # 远超 10*0.4s 的总时长
    s = tasks.get_task(t.taskId); print("重启后 5s:", s.status, s.progress, "→ 永远停在 running（僵尸任务）")
asyncio.run(main())

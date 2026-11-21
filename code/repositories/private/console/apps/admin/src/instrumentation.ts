/** Next 启动钩子：Node runtime 下拉起定时任务调度循环。 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reloadScheduler } = await import('./server/scheduler');
    const info = reloadScheduler();
    console.log(`[scheduler] 已注册 ${info.registered}/${info.total} 个定时任务`);
  }
}

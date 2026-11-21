# 5940-webview2-mem-n6 · 车道 10 · JUDGED（2026-11-11）

## 单据

- yetone/magpie#5940「webview2内存占用太大」，zerger（x_zerger），v0.1.3078，Windows 11，GUI，2026-11-10T11:18Z，c=0，OPEN。
- 排雷：零评论；`git log upstream/main --grep="#5940"` 空（"459405960" 子串误匹配甄别）；无 open PR；无 cross-reference。take：comment-6779349909。

## 判定：JUDGED（剖析结论=纯运行时行为，无 magpie 可调面）

### 证据链

1. **截图构成**（已存 5940-screenshot.png，Win11 任务管理器 WebView2 管理器 (6)，组计 1,803.7 MB）：
   - WebView2: magpie（共享 browser 进程）**1,732.2 MB = 96%**；
   - GPU 48.1 / 渲染器 18.8 / Network Service 3.2 / Storage Service 1.1 / Crashpad 0.4。
   - 渲染器/GPU 已在隐藏窗口被裁剪后的量级 ⇒ d159314e3 的 lowWhileHidden 在报告者版本**工作正常**（如常钉死：GPU 85→2.6、主渲染器 70→7.3、面板渲染器 ~50→1.3、browser 侧 ~30→6.2，fresh tray 全树 ~81 MB 私有工作集）。
   - 异常集中在 browser 进程自身 ⇒ 增长类（不属于任何窗口的页面），put_MemoryUsageTargetLevel 够不到。
2. **wails beta.24 可调面全字段核对**（module cache application_options.go:266）：WndClass/WndProcInterceptor/DisableQuitOnLastWindowClosed/WebviewUserDataPath/WebviewBrowserPath/EnabledFeatures/DisabledFeatures/AdditionalBrowserArgs/UseVisualHosting——无 browser 进程内存项。
3. **Chromium 开关透传在报告者版本可用**（#2753=3608ed782，v0.1.1291 起；windowsOptions app.go:318，AdditionalBrowserArgs :325）——但无开关能回收 browser 进程增长（--disk-cache-size=磁盘；--disable-gpu=不缩小）。
4. **报告者版本已含全部已发布缓解**：v0.1.3078（ef176e21f，2026-11-06）晚于 d159314e3（v0.1.2313，2026-10-31）与 v0.1.1291；lowWhileHidden 两窗接线 lightweight.go:60,132。
5. **同域先例家族**：#2515（28h→5.2GB，yetone 迭代 v0.1.1298/1300/1302/v0.1.2313，growth 面 10-31 末评仍未关）、#909、#1956、#2459（同题）。
6. **v0.1.3078..upstream/main 在 webview2/memtarget/lightweight 文件上无内存相关新提交**（仅 185ee6d5c 最小化恢复）——无升级建议面。
7. **反复创建面唯一**：remote_app.go OpenRemote（每次开=新 webview，关=销毁）——列入数据征集（churn 向量）。

### PATCH 候选逐一否决（消融不适用——无 patch）

- 默认 --disk-cache-size 上限：磁盘非工作集，不打 reported shape。
- 可见时也 LOW：性能倒退。
- 定期重启 browser 进程：=lightweight 已有opt-in，产品决策面（owner 曾默认开 28bec1507 v0.1.1298 后于 10-21 回退，理由=重开重载页面）。
- EmptyWorkingSet 打针：遮症状，Chromium 立即 fault 回来。

### 实名测试（行为绿，darwin d2a80b317；memoryTarget 本体需活体 WebView2=NOT-RUNNABLE 如实标）

- 绿：TestWebView2ArgsMergeTheUsers（5 子测试）、TestWebView2KeepsCodeIntegrityByDefault、TestWebView2ArgsSurviveWailsInit、TestLightStep、TestWebView2Missing、TestWebView2Notice（test-log.txt，exit=0）。
- windows-tagged 未跑（darwin）：TestWebView2Child、TestWebView2MissingFromWails。

### 数据征集（帖内已列 4 项）

重启是否复位 / 增长曲线采样 / WebView2 Runtime 版本（edge://version）/ lightweight 态与 remote 窗使用频率。

## 交付形态

- 无 commit、无 push（JUDGED 无产物提交）。帖：body.md，gh issue comment 5940 -F。
- 帖 id 待发后回填 progress 日志。

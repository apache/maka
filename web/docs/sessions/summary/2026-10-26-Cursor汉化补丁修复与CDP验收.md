# Cursor 汉化补丁修复与 CDP 渲染验收

**一句话总结**：给 Electron 系应用（Cursor）打中文补丁时，精确字符串锚点、product.json 校验和、备份过期是三处必踩的坑；用 CDP 读渲染后 DOM 比截图 OCR 更适合做界面验收。

## 背景

一个往 Cursor 安装目录注入词典补丁的汉字化扩展，在 Cursor 升级后连续出问题：应用补丁报「无法识别启动入口」、首装后无限弹重启、启动时弹「安装可能已损坏」。排查中发现根因分别是压缩变量改名、完整性校验和失效、旧备份被写回新版本。修完后需要一套可重复的验收手段，于是做了基于 CDP 的渲染层采样。

## 核心命令

```bash
# 工作目录被重置或仓库搬过家时，用 -C 指定仓库，避免 cd 链被截断
git -C <仓库路径> status --short
git -C <仓库路径> log --oneline -3

# 重命名文件并保留历史
git -C <仓库路径> mv 旧路径 新路径

# 判断某个失败是不是本次改动引入的：暂存后跑校验，再恢复
# ⚠️ stash 期间改动被移出工作区，pop 失败有丢失风险；先确认工作区无冲突再执行
git -C <仓库路径> stash -q && npm run validate:i18n ; git -C <仓库路径> stash pop -q

# 确认生成物/产物是否被 .gitignore 忽略
git -C <仓库路径> check-ignore tools/output/report.json

# 用 fnm 的指定 Node 版本跑工具链（vitest 4 需要 Node >= 20.12，系统是 18 会报 styleText 缺失）
PATH="<fnm 根>/node-versions/v22.23.2/installation:$PATH" npx vitest run

# 打包扩展必须走完整脚本链，直接 npx vsce package 不会刷新打包内的依赖副本
npm run package

# 验证产物里真的包含了修复（解包后 grep 关键符号）
unzip -p <文件名>.vsix "extension/<产物相对路径>" | grep -c "<函数名或标记>"

# Electron 应用开远程调试：隔离 profile 不影响日常使用
<App>.exe --user-data-dir=<临时目录> --remote-debugging-port=9223 \
  --remote-allow-origins=* --no-first-run

# 然后取调试目标并读 DOM
curl http://127.0.0.1:9223/json/list          # 找 type=page 的目标
# 用 WebSocket 发 Runtime.evaluate，表达式返回 JSON.stringify([...文本节点])

# 清理按命令行特征匹配的孤儿进程（Windows）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='<App>.exe'\" | Where-Object { \$_.CommandLine -like '*<profile 特征>*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

## 关键结论

1. **别用精确字符串当锚点**。压缩产物会改局部变量名（`t/m` → `esModule/baseUrl`），字符串匹配直接失效。改成按结构匹配并捕获变量名的正则，如 `/await import\(new URL\(`\$\{(\w+)\}\.js`,(\w+)\)\.href\)/`，以后改名也不受影响。
2. **「安装已损坏」不是要隐藏，是要让校验真实通过**。Electron 应用按 `product.json` 的 `checksums` 校验文件，算法是 **sha256 的 base64（去掉 `=` 填充）**，键是相对 `out/` 的路径。改了哪个受检文件就重算哪个，恢复时从备份还原。
3. **备份会过期**。应用升级只覆盖程序文件、不清理你写的 `*.backup`；若「备份存在就不更新」，回滚会把旧版本内容写回新版本。判据：当前文件未被补丁修改（非补丁态）且与备份内容不一致 → 说明升级过，用当前内容刷新备份。
4. **CDP 两个真坑**：① 一个进程常有多个 page target（启动页 + 真正的主界面），只连第一个会采到空；要枚举 `type=page` 全部采样。② 请求 `id` 必须和注册回调时的 id 一致，`send` 内部再自增会导致应答永远匹配不上——症状是所有采样超时返回空，极难从日志看出。
5. **同一版本号发布后不可覆盖**（Open VSX 即如此）。当天多次修改的版本策略要区分「已发布」和「未发布」，已发布就必须递增。

## 下次怎么用

- 给 Electron/VSCode 系应用打补丁：先备份 → 只改副本 → 最后翻转入口 → 同步受检文件校验和 → 重启验证 → 能字节级还原。
- 界面文案验收优先用 CDP 读 DOM（隔离 profile），比截图 OCR 准且零识别错误；多页面并发采样。
- 交付前一定解包验证产物内容，别只信构建成功日志。
- 发版前跑「应用 → 断言产物齐全 → 还原 → 断言字节级一致」的回归脚本，比人肉点界面可靠。
- 环境侧：编码代理的 shell 绑定固定 Git Bash 路径，Git 安装目录一搬，所有命令立刻 `spawn ... ENOENT`，需要先恢复该路径或重装 Git。

# git worktree 并行开发与 webview 弹层修复
**一句话总结**：用 git worktree 跑多分支并行开发并安全清理；顺带修掉 webview 里原生弹层的两个坑，定位一次"模型名填错"的接口 400。

## 背景
在 coding-agent 仓库同时推进架构重构（8 个工作包并行分支）和 UI 改版，主检出被另一会话占用，只能全走 worktree。收尾阶段用户实测出三个问题：配置大模型连接测试报 400、VS Code 内嵌浏览器里"点击下拉没反应"、弹层飘到页面左上角。

## 核心命令
```bash
git fetch && git worktree add ../arch -b feature/x develop   # 从指定基点开并行工作树，完全不碰主检出
git -C <仓库路径> merge --ff-only <分支>                      # 用 -C 指定仓库；--ff-only 防止意外产生合并提交
ln -sfn ../../../coding-agent/impls/typescript/node_modules node_modules  # worktree 复用主检出依赖，相对路径按目录层级算准
echo 'impls/typescript/node_modules' >> .git/info/exclude    # .gitignore 的 node_modules/ 只匹配目录、匹配不到 symlink，需本地排除；此文件所有 worktree 共享
git branch --merged main                                     # 删除前列出已合并进 main 的分支
git merge-base --is-ancestor <分支> main && echo ok          # 祖先校验，确认分支内容 100% 包含在 main
git worktree remove ../arch && git branch -d feature/x       # 删工作树；-d 只删已合并分支，未合并会拒绝
npm run check                                                # tsc --noEmit 类型门
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:ui  # playwright 必须显式给浏览器路径
lsof -iTCP -sTCP:LISTEN -P | grep node                       # 找本地服务真实监听端口
curl -s -m 15 http://127.0.0.1:<端口>/<路由>                  # 绕过 UI 直接调应用接口，看原始报错
security find-generic-password -s <服务名> -a <账户> -w      # 读 macOS 钥匙串；输出只接变量，禁止 echo
node -e "fetch(url,{headers}).then(...)"                     # 用应用同款请求直接探测第三方端点（GET /models、POST chat/completions 各一次即可定位）
```

## 关键结论
1. **模型名 400 的根因是"显示名 ≠ 接口 id"**：OpenAI 兼容端点 `GET /models` 返回 `{id:"deepseek-flash", name:"DeepSeek-V4.1-Flash"}`，请求里只能用 id。填产品显示名必 400。排查顺序：拿真实密钥直接 curl `/models` 和 `chat/completions` 各一次，立刻分清是配置错还是代码错。
2. **webview（VS Code 内嵌浏览器）里别用原生弹层**：`<datalist>` 有两层坑——Chrome 单击输入框本就不弹层（只认右缘小箭头，自定义样式下还看不见）；webview 里弹层由浏览器渲染、坐标会飘到页面角落。结论：凡"点击弹出选择"一律页内自绘 DOM 弹层（`position:fixed` 按锚点 `getBoundingClientRect()` 算坐标），不受渲染环境影响。
3. **常驻 web 服务改文件必须重启**：服务启动时 `readFileSync` 读一次前端文件；直接改磁盘上的配置文件也无效——内存态下次保存时会写回覆盖。配置修复只能走应用自己的保存接口，前端修复必须重启进程。
4. **worktree 并行开发的完整闭环**：从干净基点开树 → 依赖 symlink 复用 → 合并前跑测试 → 清理前 `--merged` + `--is-ancestor` 双校验再删。`git worktree remove` 遇脏工作区会自己拒绝，是天然保险。
5. **新校验把旧用例搞红，先怀疑潜伏缺陷**：给工具参数加 schema 校验后，一个 frozen 场景立刻红——查下来是场景的 fixture 参数名一直写错（path vs file_path），旧宽限行为掩盖了几个月。正确动作是修数据/用例，不是放宽校验。

## 下次怎么用
- **多分支并行**（重构与日常修复互不干扰）：照上面 worktree 闭环五步走，主检出永远留给"正在给人看的东西"。
- **接口报错先分清敌我**：不要隔着 UI 猜，直接 curl 应用的接口和第三方端点，一次看原始响应。
- **在 VS Code webview / 嵌入式环境做交互**：下拉、弹窗、浮层全部页内自绘，原生 `<datalist>`/`showPicker` 只在独立浏览器里可靠。
- **接 OpenAI 兼容端点**：模型名一律抄 `/models` 的 `id`；用户手填显示名是最常见的 400 来源。

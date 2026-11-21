两个现象都核对过了：都不是 bug，是 magpie 有意的行为，且都有能让它们消失的出口。逐个说：

**1. 「Pi · 未找到 CLI」——它不是「已安装」，是「卸载后留下的配置」**

magpie 判一个 agent 在不在，看的是两样东西：它的配置目录在不在、它的命令行程序在不在。`CLIMissing`（internal/agent/install.go）说的就是「**settings 还在，CLI 不在了**」：配置目录在（你机器上的 `~/.pi`，或你设过的 `PI_CONFIG_DIR`）、`pi` 命令不在 PATH 上、也没有它的桌面 app 或编辑器扩展还读着这个目录——这是一次「卸载没删干净」的形状。这一路是 #843（`~/.dsh`）、#2177（`~/.claude`）、#2173（`~/.hermes/config.yaml`）一路定下来的：这种行留在列表里、不显示任何设置、标注「未找到 CLI」，同时「安装其他 Agent」里还提供重装。你大概装过一次 pi（或某个工具建过 `~/.pi`），后来 CLI 删了，配置留下了——magpie 如实报这个状态。

不想看到它，两条路任选：
- Agents 页右下「**管理**」→ 搜 "pi" → 选中 → 「隐藏所选」。这只把它从列表里收起来，不动它的配置；
- 不打算再用 pi 的话，把 `~/.pi` 删掉，这一行下次就没了（「安装其他 Agent」里随时可以再装回来）。

**2. 「omp · lane」「omp · lane2」——这不是别的 agent，是你自己的 omp 的并行泳道**

这两行是 magpie 对 omp 多 profile 的支持（internal/agent/omp.go 的 `ompProfiles`）：omp 把每个 profile 放在 `~/.omp/profiles/<名字>/` 下，magpie 按 omp 自己的命名规则（pi-utils 的 dirs.ts）把它们列成 `omp · <名字>`。**lane 是 omp 官方的并行会话概念**（一个 lane 就是一条独立干活的工作线，Omp Fleet 这类用法会开 4–20 条），你机器上的 `lane` 和 `lane2` 是 omp 18.17.0 在 `~/.omp/profiles/` 下建的两个泳道 profile——它们不是「未知的 agent」，是你自己的 omp。

处理同样两条路：
- 不想在列表里看到：「管理」→ 搜 "omp ·" → 隐藏所选（omp 本体那行不受影响）；
- 这两条泳道确实没用了：在 omp 里清掉这两个 lane（或直接删 `~/.omp/profiles/lane` 和 `~/.omp/profiles/lane2` 目录），行就消失。

顺带说明为什么 pi 排在上面那一区：那一区是「接入过 magpie 的」，不是「已安装的」——pi 接入过（或被接入过），CLI 后来没了，所以它留在原位、去掉了设置和开关，只留一句「未找到 CLI」。它的模型下拉和开关消失也是同一件事：CLI 都不在，没有什么可设的。

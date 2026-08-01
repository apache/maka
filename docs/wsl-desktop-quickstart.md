# 在 WSL 中运行 Maka：CLI 与 Desktop 快速指南

本文说明如何在 WSL2 中开发和运行 Maka。安装过程分为三层：

1. CLI 与 Desktop 都需要的基础环境；
2. 仅 Desktop 需要的 WSLg、Electron、字体和输入法；
3. 只在特定任务中需要的可选工具。

如果只运行 CLI，完成“共同基础环境”和“运行 CLI”即可，不需要安装 Electron
图形库、CJK 字体、Fcitx5 或 X11 测试工具。

当前边界：WSL 版不提供 Computer Use，也不能控制 Windows 原生应用。

## 1. 先选择运行方式

| 项目 | CLI | Desktop |
| --- | --- | --- |
| WSL2 + Ubuntu | 必需 | 必需 |
| Node.js、npm、Git、ripgrep | 必需 | 必需 |
| WSLg | 不需要 | 必需 |
| Electron Linux 运行库 | 不需要 | 必需，按缺失项安装 |
| CJK 字体 | 终端能显示中文即可 | 建议安装 |
| Fcitx5、D-Bus、XWayland | 不需要 | 仅中文输入需要 |
| Python、Poppler | 按任务选装 | 按任务选装 |

推荐环境：

- WSL2（不是 WSL1）；
- Ubuntu 22.04 或 24.04；
- Node.js 22.19 或更新版本；
- 项目放在 WSL 的 Linux 文件系统，例如 `~/src/maka-agent`，不要优先放在
  `/mnt/c`。Linux 文件系统中的依赖安装、构建和文件监听通常更可靠。

## 2. CLI 与 Desktop 的共同基础环境

### 2.1 检查 WSL 和基础命令

在 WSL 中运行：

```bash
uname -a
node --version
npm --version
git --version
rg --version
```

在 Windows PowerShell 中可用下面的命令确认 WSL 版本：

```powershell
wsl.exe --version
wsl.exe --list --verbose
```

`wsl.exe --list --verbose` 中使用的发行版应显示为版本 `2`。

### 2.2 安装共同的系统工具

Git 和 ripgrep 是 CLI 与 Desktop 都会使用的基础工具。`ripgrep` 提供 Maka
Runtime 的 `Grep` 能力：

```bash
sudo apt update
sudo apt install -y git ripgrep ca-certificates
```

Node.js 不建议直接使用 Ubuntu 仓库中可能较旧的 `nodejs` 包。请使用你熟悉的
Node 版本管理器安装 Node.js 22.19 或更新版本，并确认 npm 为 11：

```bash
node --version
npm --version
```

如果 Node.js 已满足要求但 npm 版本较旧，可单独更新 npm：

```bash
npm install --global npm@11
```

原生模块只有在没有可用预编译包或安装报编译错误时，才需要本地编译工具：

```bash
sudo apt install -y build-essential python3 make g++
```

这组工具可能被 `node-pty` 等原生依赖使用。如果 `npm ci` 已成功，不必为了
“可能需要”而额外安装。

### 2.3 获取代码和安装依赖

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/Maka-Agent/maka-agent.git
cd maka-agent
npm ci
```

如果已经有仓库，直接进入仓库目录运行 `npm ci`。不要同时维护一份 `/mnt/c`
仓库和一份 Linux 文件系统仓库，以免在错误的副本中构建或修改代码。

## 3. 运行 CLI

只构建 CLI 所需工作区：

```bash
npm --workspace maka-agent run build
```

启动交互式 CLI：

```bash
node packages/cli/dist/cli.js
```

也可以通过 npm workspace 执行：

```bash
npm --workspace maka-agent exec -- maka
npm --workspace maka-agent exec -- maka --help
```

到这里 CLI 环境已经完成。后面的内容只适用于 Desktop，除非某一节明确标注为
可选的通用工具。

## 4. Desktop 额外环境

Desktop 是 Linux 版 Electron 应用，因此除了共同基础环境，还需要 WSLg 和
Electron 的 Linux 运行库。

### 4.1 检查 WSLg

Windows 11 通常随 WSL 提供 WSLg。在 WSL 中运行：

```bash
printf 'DISPLAY=%s\nWAYLAND_DISPLAY=%s\nXDG_RUNTIME_DIR=%s\n' \
  "${DISPLAY:-}" "${WAYLAND_DISPLAY:-}" "${XDG_RUNTIME_DIR:-}"
ls -la /mnt/wslg 2>/dev/null || true
```

正常情况下，`DISPLAY`、`WAYLAND_DISPLAY` 不为空，并且 `/mnt/wslg` 存在。

### 4.2 安装或修复 Electron

`npm ci` 首次运行会下载 Linux 版 Electron。如果安装时跳过了 Electron，或者
下载未完成，运行：

```bash
node node_modules/electron/install.js
```

网络较慢时，可以仅为当前 shell 指定镜像后重新安装依赖：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm ci
node node_modules/electron/install.js
```

不要使用下面的配置；npm 10/11 可能报告 `electron_mirror is not a valid npm
option`：

```bash
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

### 4.3 按缺失项安装 Electron 运行库

先检查 Electron 的直接动态库依赖。路径应从当前仓库计算，不要写死为
`$HOME/maka-agent`：

```bash
ELECTRON_BIN="$PWD/node_modules/electron/dist/electron"
ldd "$ELECTRON_BIN" | grep 'not found' || echo 'Electron shared libraries: OK'
```

只有出现 `not found` 或 Electron 启动时报缺库时，才安装相应软件包。以下是
Ubuntu 上常见的 Electron 运行库候选，并非每台机器都必须全部安装：

```bash
sudo apt update
sudo apt install -y \
  libnspr4 libnss3 \
  libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libatspi2.0-0 \
  libgtk-3-0 libx11-xcb1 libxcb-dri3-0 \
  libxss1 libxtst6
```

Ubuntu 22.04 如果找不到 `libasound2t64`，改用：

```bash
sudo apt install -y libasound2
```

安装后重新运行 `ldd` 检查，直到不再出现 `not found`。

### 4.4 启动 Desktop

推荐使用 HMR 开发模式：

```bash
npm run dev
```

如果希望先构建所有 workspace 再启动 Electron：

```bash
npm run dev:full
```

## 5. Desktop 显示问题

### 5.1 窗口空白或标题带 `[WARN:COPY MODE]`

这通常表示 WSLg 图形呈现链退化到 RDP Copy Mode，不一定是 Maka renderer 的
问题。先安装最小测试工具并验证通用 GUI：

```bash
sudo apt update
sudo apt install -y x11-apps x11-utils wayland-utils
xeyes -geometry 300x300+100+100
```

如果 `xeyes` 也空白，关闭 GUI 程序，在 Windows PowerShell 中执行：

```powershell
wsl --shutdown
wsl --update
```

重启 Windows 后再次测试。需要诊断时可检查 WSLg 日志：

```bash
grep -Ein 'copy.?mode|shared.memory|rdp_allocate|failed|error' \
  /mnt/wslg/stderr.log /mnt/wslg/weston.log | tail -n 120
```

先确保 `xeyes` 能正常显示，再继续排查 Maka。

### 5.2 中文显示为方框

这是 Ubuntu 缺少 CJK 字体时的典型表现，通常不是会话数据损坏：

```bash
sudo apt update
sudo apt install -y fontconfig fonts-noto-cjk fonts-noto-color-emoji
fc-cache -f
fc-match "Noto Sans CJK SC"
```

`fc-match` 应返回 Noto CJK 字体。完全退出并重启 Maka。项目 CSS 已将
`Noto Sans CJK SC` 作为 Linux 中文回退字体，通常不需要修改前端。

## 6. Desktop 中文输入

WSLg 下可以选择两条 Electron 显示路径：

| 模式 | 特点 |
| --- | --- |
| 原生 Wayland | DPI 和文字通常更清晰，但输入法依赖 WSLg 的 Wayland IME 支持 |
| XWayland | 更容易接入 XIM/Fcitx5，但 UI 可能略模糊 |

如果不需要中文输入，可以跳过本节。

### 6.1 原生 Wayland

```bash
npm --workspace @maka/desktop run dev:hmr -- \
  --enable-features=UseOzonePlatform \
  --ozone-platform=wayland \
  --enable-wayland-ime
```

### 6.2 XWayland + Fcitx5

先安装输入法和 D-Bus 支持。不同 Ubuntu 版本的 Fcitx5 包名可能略有差异，若
APT 找不到某个包，请用 `apt search fcitx5` 查找对应包：

```bash
sudo apt update
sudo apt install -y fcitx5 fcitx5-chinese-addons fcitx5-config-qt dbus-x11
dbus-run-session -- bash
```

在这个子 shell 中启动 Fcitx5。`-k` 可以避免 WSLg 移除主 Wayland 连接时
Fcitx5 自动退出：

```bash
fcitx5 -d -k
sleep 2
pgrep -af fcitx5
fcitx5-remote -n
fcitx5-configtool
```

在配置器中添加 Pinyin，然后用 `Ctrl + Space` 切换英文和拼音。不要把 `-v`
当作 verbose 参数；Fcitx5 的 `-v` 会显示版本并退出。

使用 XWayland 启动 Maka：

```bash
GTK_IM_MODULE=fcitx \
QT_IM_MODULE=fcitx \
XMODIFIERS=@im=fcitx \
npm --workspace @maka/desktop run dev:hmr -- \
  --ozone-platform=x11
```

如果原生 Wayland 出现下面的错误，说明 WSLg Weston 不允许 Fcitx5 绑定输入法
服务，应改用上面的 XWayland 方案：

```text
zwp_input_method_v1: error 0: permission to bind input_method denied
```

如果反复运行 `dbus-launch` 产生了多个 Fcitx5 实例，可以清理当前用户实例后
只启动一个：

```bash
pkill -x fcitx5 2>/dev/null || true
sleep 1
fcitx5 -d -k
sleep 2
pgrep -af fcitx5
```

## 7. CLI 与 Desktop 都可选的任务工具

这些软件不是 Maka 启动依赖，只在 Agent 需要处理相应任务时安装：

```bash
sudo apt update
sudo apt install -y python3 python3-pip poppler-utils
```

- `python3`、`python3-pip`：运行 Python 脚本；
- `poppler-utils`：提供 `pdftotext` 和 `pdfinfo`，用于提取 PDF 文本和查看元数据。

可以检查常用命令是否已在 `PATH` 中：

```bash
command -v bash
command -v node
command -v npm
command -v rg
command -v git
command -v python3
command -v pdftotext
command -v pdfinfo
```

未安装选装工具时，对应的 `command -v` 没有输出是正常的。

## 8. 验收清单

CLI：

1. `node --version` 至少为 22.19；
2. `npm ci` 和 CLI build 成功；
3. `rg --version` 正常；
4. `maka --help` 或交互式 CLI 能启动；
5. 配置模型后，能完成一次简单任务。

Desktop：

1. CLI 的共同检查全部通过；
2. WSLg 环境变量和 `/mnt/wslg` 正常；
3. Electron 的 `ldd` 检查没有缺失库；
4. `xeyes` 和 Maka 窗口都能正常显示；
5. 中文不显示为方框；
6. 根据需要选择原生 Wayland 或 XWayland + Fcitx5；
7. 最后验证模型、Shell/PTY 和内置浏览器。

如果优先稳定中文输入，当前 WSL 环境建议使用 **XWayland + Fcitx5**；如果优先
高清界面，可以使用**原生 Wayland**，但需接受输入法受 WSLg 限制。

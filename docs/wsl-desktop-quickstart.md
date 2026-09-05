# Running Maka in WSL: CLI and Desktop Quickstart

This guide explains how to develop and run Maka in WSL2. The setup is divided into three layers:

1. The base environment required by both CLI and Desktop;
2. WSLg, Electron, fonts, and input methods required only by Desktop;
3. Optional tools needed only for specific tasks.

If you only use the CLI, complete the “Shared base environment” and “Run the CLI” sections. You do not need to install Electron graphics libraries, CJK fonts, Fcitx5, or X11 test tools.

Current limitation: the WSL build does not provide Computer Use and cannot control native Windows applications.

## 0. Fast path

The following is the shortest startup path for the currently verified environment. Continue with the rest of this guide if you need to troubleshoot or understand why each step is required.

### Verified environment

- Ubuntu 26.04;
- WSL2: `Linux Admin 6.18.33.2-microsoft-standard-WSL2`;
- Node.js: `v22.23.2`;
- npm: `10.9.8` (works; npm 11 is recommended);
- Git: `2.53.0`;
- ripgrep: `15.1.0`.

### Install Git and ripgrep

Maka calls Git and ripgrep. If they are not installed, run the following in WSL:

```bash
sudo apt update
sudo apt install -y git ripgrep ca-certificates
```

### Install dependencies and build

Run these commands from an existing clone of the repository. Prefer the WSL Linux filesystem, such as `~/maka-agent`, and do not build under `/mnt/c`:

```bash
npm ci
npm run build
```

### Start the CLI

```bash
npm --workspace maka-agent exec -- maka
```

### Start Desktop

```bash
npm run dev
```

If startup succeeds, the Maka UI appears. In the currently tested WSL environment, `npm run dev` behaves like the XWayland path: Pinyin input is unavailable until an input method is configured.

### Enable Pinyin input in Desktop

Install Fcitx5 and D-Bus, then enter a new child shell:

```bash
sudo apt update
sudo apt install -y fcitx5 fcitx5-chinese-addons fcitx5-config-qt dbus-x11
dbus-run-session -- bash
```

In the new child shell, run:

```bash
fcitx5 -d -k
sleep 2
pgrep -af fcitx5
fcitx5-remote -n
fcitx5-configtool
```

Add Pinyin in the configuration window, then press `Ctrl + Space` to switch between English and Pinyin. Still in the same child shell, run:

```bash
npm run dev
```

Pinyin input should now be available.

## 1. Choose how to run Maka

| Component | CLI | Desktop |
| --- | --- | --- |
| WSL2 + Ubuntu | Required | Required |
| Node.js, npm, Git, and ripgrep | Required | Required |
| WSLg | Not required | Required |
| Electron Linux runtime libraries | Not required | Required; install missing libraries as needed |
| CJK fonts | The terminal only needs to display Chinese correctly | Recommended |
| Fcitx5, D-Bus, and XWayland | Not required | Required only for Chinese input |
| Python and Poppler | Install as needed for the task | Install as needed for the task |

Recommended environment:

- WSL2, not WSL1;
- Ubuntu 26.04;
- Node.js 22.19 or later;
- Store the project in the WSL Linux filesystem, such as `~/src/maka-agent`, instead of preferring `/mnt/c`. Dependency installation, builds, and file watching are generally more reliable on the Linux filesystem.

## 2. Shared base environment for CLI and Desktop

### 2.1 Check WSL and the base commands

Run in WSL:

```bash
uname -a
node --version
npm --version
git --version
rg --version
```

In Windows PowerShell, use the following commands to confirm the WSL version:

```powershell
wsl.exe --version
wsl.exe --list --verbose
```

The distribution shown by `wsl.exe --list --verbose` should have version `2`.

### 2.2 Install shared system tools

Git and ripgrep are base tools used by both CLI and Desktop. `ripgrep` provides Maka Runtime's `Grep` capability:

```bash
sudo apt update
sudo apt install -y git ripgrep ca-certificates
```

Installing Node.js directly from Ubuntu's repositories is not recommended because the packaged version may be old. Use a Node version manager you are familiar with to install Node.js 22.19 or later. npm 10.9.8 has been verified to work, but npm 11 is recommended:

```bash
node --version
npm --version
```

If Node.js meets the requirement but npm is older, update npm separately:

```bash
npm install --global npm@11
```

Local compilation tools are needed only when a native module has no prebuilt package or installation reports a compilation error:

```bash
sudo apt install -y build-essential python3 make g++
```

These tools may be used by native dependencies such as `node-pty`. If `npm ci` succeeds, do not install them merely because they might be needed.

### 2.3 Get the source and install dependencies

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/Maka-Agent/maka-agent.git
cd maka-agent
npm ci
```

If you already have the repository, enter its directory and run `npm ci`. Do not maintain one clone under `/mnt/c` and another in the Linux filesystem at the same time, because you may build or edit the wrong copy.

## 3. Run the CLI

The first build must build every workspace. The CLI loads compiled output for its internal dependencies from their respective `dist/` directories. Those directories do not exist in a fresh clone, so you cannot build only the CLI:

```bash
npm run build
```

Start the interactive CLI:

```bash
node packages/cli/dist/cli.js
```

You can also run it through the npm workspace:

```bash
npm --workspace maka-agent exec -- maka
npm --workspace maka-agent exec -- maka --help
```

The CLI environment is now ready. The remaining sections apply only to Desktop unless a section is explicitly marked as an optional general-purpose tool.

## 4. Additional Desktop environment

Desktop is a Linux Electron application, so it requires WSLg and Electron's Linux runtime libraries in addition to the shared base environment.

### 4.1 Check WSLg

Windows 11 normally provides WSLg with WSL. Run in WSL:

```bash
printf 'DISPLAY=%s\nWAYLAND_DISPLAY=%s\nXDG_RUNTIME_DIR=%s\n' \
  "${DISPLAY:-}" "${WAYLAND_DISPLAY:-}" "${XDG_RUNTIME_DIR:-}"
ls -la /mnt/wslg 2>/dev/null || true
```

Normally, `DISPLAY` and `WAYLAND_DISPLAY` are non-empty and `/mnt/wslg` exists.

### 4.2 Install or repair Electron

The first `npm ci` downloads the Linux Electron binary. If Electron was skipped during installation or the download did not finish, run:

```bash
node node_modules/electron/install.js
```

On a slow network, set mirrors for the current shell only, then reinstall dependencies:

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm ci
node node_modules/electron/install.js
```

Do not use the following configuration; npm 10/11 may report `electron_mirror is not a valid npm option`:

```bash
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

### 4.3 Install missing Electron runtime libraries

First, inspect Electron's direct dynamic-library dependencies. Calculate the path from the current repository instead of hard-coding `$HOME/maka-agent`:

```bash
ELECTRON_BIN="$PWD/node_modules/electron/dist/electron"
ldd "$ELECTRON_BIN" | grep 'not found' || echo 'Electron shared libraries: OK'
```

Install the corresponding packages only if `not found` appears or Electron reports a missing library at startup. The following are common Electron runtime-library candidates on Ubuntu; not every machine needs all of them:

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

After installation, run the `ldd` check again until `not found` no longer appears.

### 4.4 Start Desktop

HMR development mode is recommended:

```bash
npm run dev
```

In the currently verified WSL environment, this quick-start command behaves like the XWayland path. It is the simplest option, but the UI may look slightly blurry. After configuring Fcitx5, you can also use this command directly to verify Chinese input. To explicitly fix the XWayland and input-method environment, or for troubleshooting, use the explicit command in [6.2](#62-xwayland--fcitx5).

To build all workspaces before starting Electron:

```bash
npm run dev:full
```

## 5. Desktop display issues

### 5.1 Blank window or a title containing `[WARN:COPY MODE]`

This normally means the WSLg graphics rendering chain has fallen back to RDP Copy Mode; it does not necessarily indicate a problem in the Maka renderer. Install minimal test tools and verify a generic GUI first:

```bash
sudo apt update
sudo apt install -y x11-apps x11-utils wayland-utils
xeyes -geometry 300x300+100+100
```

If `xeyes` is also blank, close GUI applications and run the following in Windows PowerShell:

```powershell
wsl --shutdown
wsl --update
```

Restart Windows and test again. For diagnostics, inspect the WSLg logs:

```bash
grep -Ein 'copy.?mode|shared.memory|rdp_allocate|failed|error' \
  /mnt/wslg/stderr.log /mnt/wslg/weston.log | tail -n 120
```

Make sure `xeyes` displays correctly before continuing to troubleshoot Maka.

### 5.2 Chinese characters appear as boxes

This is typical when Ubuntu lacks CJK fonts and usually does not indicate corrupted session data:

```bash
sudo apt update
sudo apt install -y fontconfig fonts-noto-cjk fonts-noto-color-emoji
fc-cache -f
fc-match "Noto Sans CJK SC"
```

`fc-match` should return a Noto CJK font. Fully quit and restart Maka. The project CSS already uses `Noto Sans CJK SC` as the Linux Chinese fallback font, so frontend changes are normally unnecessary.

## 6. Chinese input in Desktop

WSLg supports two Electron display paths:

| Mode | Characteristics |
| --- | --- |
| Native Wayland | DPI and text are normally sharper, but the input method depends on WSLg's Wayland IME support |
| XWayland | Easier to integrate with XIM/Fcitx5, but the UI may look slightly blurry |

Skip this section if you do not need Chinese input.

### 6.1 Native Wayland

```bash
npm --workspace @maka/desktop run dev:hmr -- \
  --enable-features=UseOzonePlatform \
  --ozone-platform=wayland \
  --enable-wayland-ime
```

### 6.2 XWayland + Fcitx5

First install the input method and D-Bus support. Fcitx5 package names may vary slightly between Ubuntu versions. If APT cannot find a package, use `apt search fcitx5` to locate the corresponding package:

```bash
sudo apt update
sudo apt install -y fcitx5 fcitx5-chinese-addons fcitx5-config-qt dbus-x11
dbus-run-session -- bash
```

Start Fcitx5 in this child shell. The `-k` option prevents Fcitx5 from exiting automatically when WSLg removes the primary Wayland connection:

```bash
fcitx5 -d -k
sleep 2
pgrep -af fcitx5
fcitx5-remote -n
fcitx5-configtool
```

Add Pinyin in the configuration tool, then use `Ctrl + Space` to switch between English and Pinyin. Do not treat `-v` as a verbose option; Fcitx5 uses `-v` to print its version and exit.

In the currently verified WSL environment, after completing the Fcitx5 configuration above, you can run `npm run dev` directly in this child shell and use `Ctrl + Space` to verify Pinyin input.

To explicitly fix the XWayland and Fcitx5 environment, use the following command:

```bash
GTK_IM_MODULE=fcitx \
QT_IM_MODULE=fcitx \
XMODIFIERS=@im=fcitx \
npm --workspace @maka/desktop run dev:hmr -- \
  --ozone-platform=x11
```

If native Wayland reports the following error, WSLg's Weston does not allow Fcitx5 to bind the input-method service. Use the XWayland approach above instead:

```text
zwp_input_method_v1: error 0: permission to bind input_method denied
```

If repeatedly running `dbus-launch` creates multiple Fcitx5 instances, clean up the current user's instances and start only one:

```bash
pkill -x fcitx5 2>/dev/null || true
sleep 1
fcitx5 -d -k
sleep 2
pgrep -af fcitx5
```

## 7. Optional task tools for CLI and Desktop

These packages are not Maka startup dependencies. Install them only when an agent needs to handle the corresponding task:

```bash
sudo apt update
sudo apt install -y python3 python3-pip poppler-utils
```

- `python3` and `python3-pip`: run Python scripts;
- `poppler-utils`: provides `pdftotext` and `pdfinfo` for extracting PDF text and inspecting metadata.

Check whether common commands are available on `PATH`:

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

If an optional tool is not installed, no output from its corresponding `command -v` is expected.

## 8. Acceptance checklist

CLI:

1. `node --version` is at least 22.19;
2. `npm ci` and the CLI build succeed;
3. `rg --version` works;
4. `maka --help` or the interactive CLI starts;
5. After configuring a model, Maka can complete a simple task.

Desktop:

1. All shared CLI checks pass;
2. The WSLg environment variables and `/mnt/wslg` are correct;
3. Electron's `ldd` check reports no missing libraries;
4. Both `xeyes` and the Maka window display correctly;
5. Chinese characters do not appear as boxes;
6. Select native Wayland or XWayland + Fcitx5 as needed;
7. Finally, verify the model, Shell/PTY, and built-in browser.

If stable Chinese input is the priority, **XWayland + Fcitx5** is recommended in the current WSL environment. If a sharp UI is the priority, use **native Wayland**, but accept that input-method support is limited by WSLg.

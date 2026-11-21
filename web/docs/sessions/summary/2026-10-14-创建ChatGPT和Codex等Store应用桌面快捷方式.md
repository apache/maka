# Win10 给 ChatGPT / Codex 等 Store 应用创建桌面快捷方式

**结论**：这类应用是 Microsoft Store（MSIX）应用，装在系统保护的 `C:\Program Files\WindowsApps\` 里且路径带版本号（更新就变），**不能直接对 exe 建快捷方式**；正确做法是让快捷方式指向系统的应用入口 `shell:AppsFolder\<包族名>!<应用ID>`，更新后依然有效。日常用一个更懒的办法就够了：**开始菜单搜到应用，直接拖到桌面**。

## 为什么找不到它们的位置

| 现象 | 原因 |
| --- | --- |
| 资源管理器里翻不到安装目录 | `C:\Program Files\WindowsApps\` 受系统 ACL 保护，默认无权浏览 |
| 侥幸进去建了快捷方式，过阵子失效 | 目录名含版本号，如 `OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0`，应用一更新路径就换 |
| 安装了"两个 ChatGPT"分不清 | OpenAI 新版应用的包名就叫 `OpenAI.Codex`，开始菜单里显示为 "ChatGPT"；旧版包名 `OpenAI.ChatGPT-Desktop`，显示为 "ChatGPT Classic" |

## 方法一：开始菜单拖拽（推荐，10 秒）

1. 按 `Win` 键，输入应用名（如 `ChatGPT`）。
2. 在搜索结果上**按住左键，直接拖到桌面空白处松手**——快捷方式立即生成，指向系统应用入口，不怕更新。

备选操作：搜索结果上右键 → **打开文件位置** → 资源管理器会打开开始菜单程序文件夹（`%AppData%\Microsoft\Windows\Start Menu\Programs`）并选中对应 `.lnk` → 右键 → **发送到 → 桌面快捷方式**。效果相同，多两步。

> ponytail：能拖拽就别写脚本。方法二只在应用不在开始菜单显示、要批量建、或要把建法写进部署脚本时才用。

## 方法二：PowerShell 指向 shell:AppsFolder（通用、可脚本化）

### 第 1 步：查包族名和应用 ID

```powershell
# 按关键词找包（支持通配符），拿到 PackageFamilyName
Get-AppxPackage *openai* | Select-Object Name, PackageFamilyName, InstallLocation

# 拿包内每个入口的 AppId（一个包可能有多个入口，选主 GUI 那个）
$p = Get-AppxPackage OpenAI.Codex
(Get-AppxPackageManifest $p).Package.Applications.Application | Select-Object Id, Executable
```

AppId 拼在包族名后面，格式：`<PackageFamilyName>!<AppId>`。

### 第 2 步：创建快捷方式

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:USERPROFILE\Desktop\ChatGPT.lnk")
$lnk.TargetPath = "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App"
$lnk.Save()
```

注意：`TargetPath` 设成 `shell:AppsFolder\...` 后，用 `$ws.CreateShortcut(...).TargetPath` 读回来是**空字符串**，这是正常现象——shell 目标存在 .lnk 的 IDList 里，不在路径字段里。别以为没写进去（本人实测在这上面疑心过一次）。

### 本次两个应用的实际入口

| 桌面快捷方式 | 开始菜单显示名 | TargetPath 应填 |
| --- | --- | --- |
| `ChatGPT.lnk` | ChatGPT（新版，Codex 已并入） | `shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App` |
| `ChatGPT Classic.lnk` | ChatGPT Classic（旧版） | `shell:AppsFolder\OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT` |

`OpenAI.Codex` 包里还有个入口 `CodexCoreCommandRunner`（`codex-command-runner.exe`），那是后台命令执行器，不要给它建快捷方式。

## 验证

双击前的静态核验（不启动应用）：

```powershell
$item = (New-Object -ComObject Shell.Application).Namespace("C:\Users\802165\Desktop").ParseName("ChatGPT.lnk")
$item.ExtendedProperty("System.Link.TargetParsingPath")
# 期望输出：OpenAI.Codex_2p2nqsd0c76g0!App
```

返回的字符串就是快捷方式真正指向的应用 ID；输出为空说明目标没存进去，重建即可。两个快捷方式已于 2026-10-14 用此法验证通过并可用。

## 容易踩的坑

| 坑 | 说明 |
| --- | --- |
| 包名骗人 | 找 "Codex" 的桌面应用，实际包叫 `OpenAI.Codex`、显示名叫 "ChatGPT"。以 `Get-AppxPackage` + manifest 的输出为准，别按直觉猜 |
| 一个包多个 AppId | 先用 manifest 列出全部入口再选，选错会拉起后台进程而非主窗口 |
| 直接指 exe | `WindowsApps` 下的绝对路径带版本号，更新即断链；一律走 `shell:AppsFolder` |
| Git Bash 里跑 PowerShell | `$_` 这类符号会被 bash 吞掉导致命令碎裂；把整段命令用单引号包住传给 `powershell -NoProfile -Command '...'`，或直接在 PowerShell 窗口里跑 |

## 区分：CLI 版 Codex 不需要快捷方式

终端里的 `codex` 命令是 npm 全局安装的 CLI（本机位于 `C:\Users\802165\AppData\Roaming\npm\codex.cmd`），在终端直接敲就能用，与上面的桌面应用是两回事。

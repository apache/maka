# Windows 下 adb 无线调试排查与环境变量 Path 低耦合重构

> 本对话解决两个独立问题：① HONOR 100 Pro 通过 USB 安装 APK 时 adb 报 `no devices/emulators found`，定位根因并改用无线调试完成安装；② 按要求把用户级/系统级 Path 从硬编码绝对路径重构为 `%XXX%` 变量引用风格。

---

## 一、问题一：adb 报 no devices/emulators found

### 1.1 背景与目标

- 环境：Windows 10 22H2 (19045.6456)，主机 `HeT-HLW0609`，用户名 `802165`；platform-tools 37.0.0-14901028 位于 `D:\DevTools\Languages\Android\platform-tools`
- 手机：HONOR 100 Pro（型号 MAA-AN10），USB VID `339B` / PID `107D`
- 目标：把 `C:\Users\802165\Downloads\jev-assistant-v1.3-release.apk` 装到手机
- 症状：`adb install -r ...` 报 `adb.exe: no devices/emulators found`；`adb devices -l` 设备列表为空

### 1.2 最终结论（根因）

**与环境变量无关**（adb 能打印版本号即证明 Path 生效），根因是设备枚举机制不匹配：

- 荣耀 VID `339B` 不在 Google USB 驱动的硬件 ID 列表里，Windows 10 走"手机 MS OS 描述符声明 + 微软 winusb.inf 自动绑定"的免驱路径
- 免驱路径注册的设备接口 GUID 与 Google USB 驱动 INF 声明的那条不重合（注册表实测 Google GUID 下无任何设备）
- 该 platform-tools 自带 `AdbWinApi.dll`/`AdbWinUsbApi.dll`，走经典 Windows 枚举后端（`usb_windows.cpp`），**只认 Google 驱动注册的接口 GUID** → 接口在、驱动在，但 adb 永远扫不到

> 机制细节为基于 adb 源码知识的推断，证据链：Google GUID 注册表为空 + 免驱 WinUSB 绑定正常 + 服务端 trace 0 设备 + AdbWinApi 存在。

### 1.3 排查过程（可复现证据链）

| # | 动作 | 命令 | 结果 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 查 adb 解析 | `where adb` | 指向 platform-tools 目录，与用户变量 `ADB_HOME` 一致 | 排除环境变量（adb 不读 `ADB_HOME`，起作用的是 Path） |
| 2 | 查设备树 | `Get-PnpDevice -PresentOnly` | 复合设备 4 接口：MI_00 WPD(MTP) OK、MI_01 大容量存储 OK、MI_02 ADB Interface OK、MI_03 HDB Interface **Error** | USB 调试已开、线可传数据；HDB 是荣耀自家通道，报错**不用管** |
| 3 | 查接口驱动 | `Get-PnpDeviceProperty -InstanceId 'USB\VID_339B&PID_107D&MI_02\...'` | Service=`WINUSB`，Provider=Microsoft，winusb.inf 10.0.19041.1 | 免驱绑定正常，不是驱动缺失 |
| 4 | 重启服务端 | `adb kill-server` → `adb devices` | 仍为空 | 非状态陈旧 |
| 5 | 抓服务端 USB 扫描 | `ADB_TRACE=usb adb nodaemon server`（日志落文件再 grep） | `usb_windows.cpp` 设备线程启动，0 条设备记录 | adb 枚举根本没扫到该接口 |
| 6 | 查 Google GUID 注册 | `reg query "HKLM\SYSTEM\CurrentControlSet\Control\DeviceClasses\{F72FE0D4-CBCB-407d-8814-9ED673D0DD6B}" /s` | 空 | **根因坐实** |
| 7 | 重启 USB 接口 | `pnputil /restart-device ...` | 拒绝访问（需管理员） | 治标不治本，放弃 |

### 1.4 有效方案：无线调试（已验证成功）

Android 11+ 的无线调试是纯 TCP 通道，完全绕开 Windows USB 驱动栈。

```powershell
# 步骤 0：手机必须关闭 VPN（否则无线调试页面显示 VPN 虚拟网卡地址，如 172.19.0.1，电脑不可达）
# 步骤 1：手机 开发者选项 → 无线调试 → 使用配对码配对设备（弹窗保持打开）
adb pair 10.6.24.162:43437          # 配对端口，一次性
# → 输入 6 位配对码 → Successfully paired to 10.6.24.162:43437 [guid=adb-<SN>-<xxxx>]

# 步骤 2：用无线调试【主页面】的 IP:端口连接（与配对端口不是一个）
adb connect 10.6.24.162:37023
# → connected to 10.6.24.162:37023

adb devices -l
# → 10.6.24.162:37023  device product:MAA-AN10 model:MAA_AN10 device:HNMAP

# 步骤 3：安装
adb -s 10.6.24.162:37023 install -r C:\Users\802165\Downloads\jev-assistant-v1.3-release.apk
# → Performing Streamed Install → Success（手机端确认安装成功）
```

### 1.5 失败/无效尝试及原因

| 尝试 | 结果 | 原因 |
| --- | --- | --- |
| `adb kill-server` 重启 | 无效 | 枚举机制问题，不是服务端状态 |
| `adb connect 172.19.0.1:37023`（VPN 开时显示的地址） | 10060 超时 / ping 100% 丢包 | 那是手机 VPN 虚拟网卡地址，电脑路由不可达 |
| `adb mdns services` 自动发现 | 空列表 | 电脑有线(10.6.33.85)与手机 Wi-Fi(10.6.24.162)跨广播域，组播不通；直连不受影响 |
| `pnputil /restart-device` | 拒绝访问 | 需管理员提权，且不改变 GUID 枚举机制 |
| 手改 Google USB 驱动 INF 加 VID | 未执行 | 修改后 INF 与 WHQL 签名目录失配，Win10 x64 拒装 |

### 1.6 有线备选方案（未执行）

装荣耀官方驱动（荣耀手机助手 HiSuite 自带），装完重插手机即可。**不推荐**手改 Google INF 路线（签名问题，代价远超收益）。

### 1.7 本次踩坑清单

- `no devices/emulators found` 第一嫌疑不应是环境变量：adb 能跑就说明 Path 通了
- 手机开 VPN 时无线调试页面显示 VPN 虚拟地址 → 先关 VPN 再看端口
- **配对成功 ≠ 已连接**：pair 只交换钥匙，connect 才建立会话；两个端口不同，配对码一次性
- 手机"已配对的设备"列表条目是客户端身份（`用户名@主机名`）：本机是 `802165@HeT-HLW0609`，列表中已有的 `802164@C-03-2004-0150` 是别的电脑留下的，换电脑必须重新配对
- HONOR/华为机型的 `HDB Interface` 报黄叹号无需处理
- 无线调试端口以页面显示为准；断开后只需重跑 `adb connect <新端口>`，配对关系持久

---

## 二、问题二：环境变量 Path 低耦合重构

### 2.1 背景与目标

- 现状问题：用户主 Path 25 条、系统 Path 13 条几乎全是硬编码绝对路径（多处为 `D:\DevTools\...` 前缀重复），改根目录要逐条改
- 目标风格（用户指定）：工具根变量（图一风格：`ADB_HOME`/`FNM_DIR`/`GOPATH`/`JAVA_HOME`）+ Path 一律用 `%XXX%` 引用；Path 里只保留真正无法归类的绝对路径

### 2.2 最终方案

**新建变量（6 个）**

| 作用域 | 变量 | 值 | 说明 |
| --- | --- | --- | --- |
| 系统 | `DEV_TOOLS` | `D:\DevTools` | 根锚点，**必须系统级**：系统 Path 引导期展开只能引用系统变量 |
| 系统 | `GOROOT` | `D:\DevTools\Languages\Backend\Golang\Go` | Go 官方标准变量 |
| 系统 | `NODE_HOME` | `D:\DevTools\Languages\Frontend\NodeJS` | 无官方冲突 |
| 系统 | `PYTHON_DIR` | `D:\DevTools\Languages\Backend\Python` | **刻意不用 `PYTHON_HOME`**：`PYTHONHOME` 是 Python 官方运行时变量（标准库查找路径），命名冲突会让 Python 程序找不到库 |
| 用户 | `AI_TOOLS` | `%DEV_TOOLS%\AI`（REG_EXPAND_SZ） | 嵌套引用，AI 工具改根一处生效 |
| 用户 | `MYSQLSH_HOME` | `D:\DevTools\Languages\Database\MySQL\Server\8.0\Shell` | MySQL Shell 官方变量名 |

**Path 改写四类**（保持原顺序，逐条规范化）

1. 挂已有变量：`%JAVA_HOME%\bin`、`%ADB_HOME%`、`%FNM_DIR%`
2. 挂标准用户变量：`.grok`/`.cargo`/`.amp`/`.local` → `%USERPROFILE%\...`；Volta/WindowsApps/Pandoc → `%LOCALAPPDATA%\...`；npm → `%APPDATA%\npm`
3. 挂新建变量：7 个 AI 工具 → `%AI_TOOLS%\厂商\工具\bin`；VS Code、Bandizip、Git、微信开发者工具、Redis → `%DEV_TOOLS%\...`；MySQL Shell → `%MYSQLSH_HOME%\bin`；Go/Node/Python → `%GOROOT%\bin`、`%NODE_HOME%`、`%PYTHON_DIR%`(+`\Scripts`)
4. 保留绝对路径（系统标准位置，无可挂变量）：`D:\Program Files\Bandizip`（用户侧）、`C:\Program Files\dotnet\`、`C:\Program Files\GitHub CLI\`（系统侧）

**顺带清理**：原用户 Path 末尾存在重复的 `%ADB_HOME%` 空条目（与中间 platform-tools 绝对路径重复），已去重；条目尾部多余反斜杠已统一。

### 2.3 关键实现细节

| 要点 | 做法 | 原因 |
| --- | --- | --- |
| 备份 | `reg export HKCU\Environment user-env-backup.reg` + HKLM 同款 | .reg 双击即回滚，比记录文本可靠 |
| 读取精确值 | `reg query`（**不要信截图**：截图里 MySQL 看着是 `Server 8.0` 实际是 `Server\8.0` 两层） | 截图会截断、字体易混 |
| 写入类型 | PowerShell `Set-ItemProperty -Type ExpandString` | Path 必须是 `REG_EXPAND_SZ`，否则 `%VAR%` 不展开；`setx` 会写 REG_SZ 且有 1024 字符截断风险，不可用 |
| 新变量类型 | 值含 `%` → ExpandString；纯路径 → String | 嵌套变量（AI_TOOLS）必须 EXPAND_SZ |
| **真 raw 值验证** | 用 `reg query` 看字面值 | .NET `[Environment]::GetEnvironmentVariable` 会自动展开 REG_EXPAND_SZ，显示出的"raw"是假 raw（已踩坑：显示的 `%FNM_DIR%` 展开结果带正斜杠，注册表实际存的是干净的 `%FNM_DIR%`） |
| 脚本编码 | 中文字符只放数据文件（.txt，`Get-Content -Encoding UTF8` 读），ps1 脚本本身不含中文字面量 | PowerShell 5.1 读无 BOM UTF-8 的 .ps1 按 ANSI 解析，中文会乱码 |
| 提权写入 | `Start-Process powershell -Verb RunAs -Wait -File apply-system.ps1`，脚本内写日志文件 | HKLM 需管理员；日志回读避免提权窗口关闭后无反馈 |
| 生效通知 | 脚本末尾 P/Invoke `SendMessageTimeout(HWND_BROADCAST=0xffff, WM_SETTINGCHANGE=0x001A, 'Environment', SMTO_ABORTIFHUNG=0x0002)` | 通知 Explorer 刷新，新开进程即时生效 |

### 2.4 验证结果

- `reg query` 确认：用户/系统 Path 均为 `REG_EXPAND_SZ` 且字面值正确；`AI_TOOLS`、`MYSQLSH_HOME`、4 个系统变量全部落库
- `verify-env.ps1`（读 HKLM+HKCU 构造变量表 → MatchEvaluator 多轮展开 → Test-Path 逐条检查）：用户 Path 24 条、系统 Path 13 条**全部展开且路径存在**，仅 1 条例外见遗留问题
- 新开终端/软件直接生效；已打开的窗口需重开

### 2.5 资产清单（E:\ggbdpq\guahub\docs\tools\env-backup-2026-09-22\）

| 文件 | 用途 |
| --- | --- |
| `user-env-backup.reg` / `system-env-backup.reg` | 改写前原始值，双击回滚 |
| `user-path-new.txt` / `sys-path-new.txt` | 新 Path 数据（含中文，UTF-8） |
| `user-vars-new.txt` / `sys-vars-new.txt` | 新变量数据 |
| `apply-user.ps1` / `apply-system.ps1` | 用户级（免提权）/ 系统级（需 UAC）写入脚本 |
| `verify-env.ps1` | 展开 + 存在性验证脚本（只读） |
| `apply-system.log` | 提权执行结果 |

---

## 三、通用经验（可迁移）

1. **环境变量重构方法论**：备份(.reg) → `reg query` 读精确值（不信截图）→ 按"已有变量/标准变量/新建根变量/保留绝对"四类设计映射 → 数据文件+脚本分离写入（防编码坑）→ 用户级/系统级分开处理（系统级提权+日志回读）→ 验证"字面值+展开值+路径存在性"三层
2. **adb 无线调试是 Windows 驱动/枚举异常场景的通用绕行**：纯 TCP，不依赖任何 USB 驱动，Android 11+ 可用；`adb pair`（一次性配对码）+ `adb connect`（主端口）两步缺一不可
3. **"工具显示的原始值"可能是自动展开后的值**：凡涉及 REG_EXPAND_SZ，判定真值一律用 `reg query`
4. **PowerShell 脚本编码铁律**：含非 ASCII 的数据与脚本分离，数据用显式 `-Encoding UTF8` 读取
5. **提权脚本模式**：`-Verb RunAs -Wait` + 脚本内自写日志，主流程读日志判定结果，避免"UAC 窗口关了不知道成没成"
6. **系统 Path 只能引用系统变量**：引导早期用户变量不存在，跨作用域引用方向只能是"用户引用系统"

---

## 四、新会话快速恢复上下文

**项目现状**

1. 即问助手 APK（`jev-assistant-v1.3-release.apk`）已通过**无线调试**成功安装到 HONOR 100 Pro（MAA-AN10）。该手机 USB 有线通道在 Windows 上**确认不可用**（免驱 WinUSB 与 adb 经典枚举 GUID 不匹配），后续所有 adb 操作一律走无线调试。
2. 无线调试连接命令：`adb connect 10.6.24.162:<主页面端口>`（端口以手机无线调试页面实时显示为准；手机开 VPN 会导致地址异常，连接前先关 VPN）。
3. 环境变量重构**已完成并验证**：用户级+系统级 Path 全部变量化；如需回滚，双击 `E:\ggbdpq\guahub\docs\tools\env-backup-2026-09-22\` 下两个 .reg 文件。

**关键决策**

- 手机（荣耀 VID 339B）不再折腾 USB 驱动，无线调试为默认方案；有线根治若要做，唯一推荐路径是装 HiSuite 官方驱动
- 环境变量命名：`PYTHON_DIR`（避开官方 `PYTHONHOME`）、`DEV_TOOLS` 放系统级、`AI_TOOLS` 用户级嵌套引用
- 环境变量改动一律"先备份 .reg 再写注册表"

**下一步工作**

- 遗留：用户 Path 中 `D:\Program Files\Bandizip` 已不存在（Bandizip 实际在 `D:\DevTools\System\Bandizip`，该条已在 Path 中），待用户确认后删除该死路径
- 遗留：检查其他未展开验证过的自定义变量（如 `FNM_DIR` 在部分会话显示正斜杠，注册表值正常，暂无需处理）
- 相关沉淀：adb 排查完整版文章在 `E:\ggbdpq\guahub\docs\adb\2026-09-22-adb无设备排查到无线调试解决.md`

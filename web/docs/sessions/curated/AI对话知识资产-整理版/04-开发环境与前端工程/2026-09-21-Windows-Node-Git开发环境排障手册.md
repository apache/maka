# 01-Windows-Node-Git开发环境排障手册

> 由 10 份 AI 对话沉淀合并。整理目标是保留可复用事实、决策与验证结果，压缩聊天过程。

## 核心沉淀

- Windows 开发环境排障优先检查 PATH、shell 差异、Node/fnm 实际生效路径、Git transport（HTTPS/SSH/代理）与 Visual Studio Build Tools 组件状态。
- Git 问题要把代理、SSH 公钥、stash、当前分支与远端状态分别验证，避免一次性修改多层配置导致定位失真。
- 系统级清理如右键菜单和环境变量修改必须可回滚，先导出注册表或记录原值；端口选择与工具安装遵循“标准优先、冲突检测、最小权限”。

## 来源与整合内容

### 来源：Win11开发环境全套绿色工具部署与权限排坑方案.md

### 二、核心结论

1. Windows11下开发数据库**优先前台手动启动，不推荐注册Windows系统服务**，大幅减少NTFS权限、账户访问、注册表相关故障，足够满足本地开发调试。
2. D盘多层嵌套目录会继承父目录NTFS权限锁，PostgreSQL执行initdb修改目录权限（强制0700）时极易报Permission denied；解决方案：`takeown`夺取目录所有权 + `icacls`重置ACL；仍失败则D盘根目录临时初始化data目录，初始化完成后迁移至目标路径。
3. 所有工具统一使用纯英文路径，禁止中文、空格、特殊符号；优先绿色zip包，减少安装器的隐式副作用。
4. 国内开发必须配置各包管理器国内镜像源（Go、Rust、Python pip、Maven），解决网络拉取超时问题。

### 一、背景与问题

用户在Windows11环境搭建全套后端+前端配套开发工具，**统一采用D盘分层目录管理，优先绿色zip二进制包，尽量规避exe安装程序带来的各种问题**。
核心痛点：
1. PostgreSQL绿色包在D盘多层嵌套目录执行initdb，出现NTFS目录权限`Permission denied`报错（Windows特有多层文件夹ACL锁死问题）；
2. 大量数据库服务注册Windows系统服务时极易权限失败；
3. 统一规划开发工具目录结构：`D:\DevTools\Languages\`，数据库统一放置在`D:\DevTools\Languages\Database\`；
4. 需要一套标准化、可复制、带避坑清单的完整部署文档，覆盖编程语言、数据库、Web中间件、版本控制工具。

### 五、踩坑记录 & 错误认知纠正

1. ❌ 错误认知：只给data目录赋权就能解决initdb权限报错 ✅ 真相：Windows多层嵌套目录上层ACL锁死，单纯icacls赋权无效，**必须先用takeown夺取目录所有权**。
2. ❌ 错误认知：数据库一定要注册成Windows后台服务 ✅ 真相：D盘多层目录场景，NETWORK SERVICE账户读写权限极易失败；本地开发前台启动足够用，大幅降低排坑成本。
3. ❌ 错误认知：PostgreSQL EDB图形安装包更好用 ✅ 真相：EDB安装包存在InstallBuilder解析bug，D盘深层目录极易报错；优先官方zip绿色二进制包。
4. ❌ 错误认知：data文件夹手动建好即可 ✅ 真相：MySQL、PostgreSQL的data目录需要由初始化命令自动生成，手动创建容易权限异常。
5. ❌ 错误认知：Windows下Rust直接安装就能编译 ✅ 真相：缺少MSVC编译链，会直接报linker找不到，必须安装VS Build Tools。
6. ❌ 错误认知：Windows Nginx可以直接双击运行 ✅ 真相：双击会创建多个后台残留进程，很难清理，统一使用命令行启停。
7. ❌ 错误认知：Python安装时PATH可以后期随便补 ✅ 真相：忘记勾选Add Python to PATH会触发微软商店python别名劫持，需要手动关闭应用别名开关。

### 七、后续建议

1. 备份：定期备份各个数据库`data`目录，重装系统前优先导出数据库数据。
2. 版本管理：多版本语言可后续增加版本管理器（fnm、pyenv-win、jenv）。
3. 环境迁移：新电脑搭建环境，直接复用本文档整套脚本与目录结构。
4. 防火墙：本地开发可放行数据库端口，按需限制外部访问。

### 来源：Windows PowerShell配置fnm Node版本管理器环境变量排错方案.md

### 核心结论

1. 根本原因：PATH里使用`%FNM_DIR%`变量引用，Windows用户环境变量存在解析缓存，导致PATH加载失败；并且错误地把镜像地址变量写入PATH，破坏PATH列表。
2. PowerShell和CMD读取环境变量语法不同：CMD使用`%VAR%`，PowerShell使用`$env:VAR`，混用会报错。
3. PowerShell profile.ps1需要增加容错判断，避免终端启动直接抛错。
4. 修复最优方案：PATH直接填写fnm完整绝对目录，放弃PATH中使用变量占位符。

### 背景与问题

在Windows系统使用fnm（Node版本管理器），出现现象：
1. 使用绝对路径执行`D:\DevTools\Language\Fnm\fnm.exe --version`可正常输出版本，程序文件本身完好；
2. PowerShell终端中直接输入`fnm`命令，提示`fn: The term 'fnm' is not recognized`命令找不到；
3. 打开PowerShell时，profile.ps1启动脚本报红；
4. 环境变量`$env:FNM_DIR`、`$env:FNM_NODE_DIST_MIRROR`变量读取正常，但PATH中`%FNM_DIR%`变量无法正常解析；
5. 错误认知：尝试在PowerShell使用CMD风格`%变量名%`语法读取环境变量，直接触发命令报错。

> 环境信息：Windows，PowerShell，fnm v1.39.0，fnm安装目录`D:\DevTools\Language\Fnm`，配置国内Node镜像。

### 有效方案（方案1，推荐）

### 步骤1：打开环境变量
Win+R → `sysdm.cpl` → 高级 → 环境变量，在**用户变量**区域找到Path并双击编辑。
### 步骤2：修改PATH条目
1. 删除旧条目：`%FNM_DIR%`；
2. 删除无效条目：`%FNM_NODE_DIST_MIRROR%`；
3. 新建条目，填入绝对路径：`D:\DevTools\Language\Fnm`；
4. 所有弹窗依次点【确定】保存。
### 步骤3：修改PowerShell profile.ps1，增加容错
```powershell

### 踩坑与错误认知

1. ❌ 错误：在PowerShell中使用`%FNM_DIR%`读取环境变量，PowerShell不支持CMD百分号语法；
2. ❌ 错误：将Node镜像地址`FNM_NODE_DIST_MIRROR`添加进PATH；PATH仅支持文件夹路径，网址会破坏PATH；
3. ❌ 错误：修改环境变量后，只新开PowerShell窗口，不关闭原有所有终端，旧缓存导致PATH不更新；
4. ❌ 错误：profile.ps1直接执行`fnm env`，不增加存在性判断，终端打开瞬间直接抛出命令找不到的错误。

### 后续建议

1. 修复成功后，测试`fnm install`安装Node版本，验证国内镜像是否生效；
2. 后续重装fnm、移动fnm目录时，只需要同步修改PATH里这条绝对路径即可；
3. 若切换到PowerShell 7，profile文件路径会变化，需要单独配置。

```
你可以复制上面全部内容保存为 `Windows PowerShell配置fnm Node版本管理器环境变量排错方案.md`。
这份文档属于前端开发环境排错资产，后续重装机器、配置新Windows开发环境遇到fnm同类问题都可以复用。

要不要我再帮你精简一份**快速排查清单**附在文档末尾，方便以后快速自检？
```

### 来源：Win10 CMD执行npm命令提示【文件名、目录名或卷标语法不正确】排查修复方案.md

### 核心结论

1. 报错根本原因：**系统环境变量PATH中存在CMD无法解析的非法路径**（最常见是包含波浪号`~`，fnm/nvm工具会自动注入这类路径，CMD原生不支持`~`简写路径，PowerShell无此限制）。
2. 次要问题：npm自身config里prefix/cache缓存路径配置非法，会继续触发报错。
3. 附加小问题：npm命令参数书写错误，`--depth==0`多写了一个等号。

### 背景与问题

环境：Windows10，Node v24.17.0，安装路径 D:\DevTools\Language\NodeJS
现象：
1. 打开CMD，直接输出报错：`文件名、目录名或卷标语法不正确。`
2. `node -v` 可以正常输出版本号；但执行npm相关命令（npm update、npm ls -g）都会触发同样报错。
3. 附带npm警告：`invalid config depth=="=0"`，属于参数书写错误。

### 文件名称：《Win10 CMD执行npm命令提示【文件名、目录名或卷标语法不正确】排查修复方案.md》

```

### Win10 CMD执行npm命令提示【文件名、目录名或卷标语法不正确】排查修复方案

## 背景与问题
环境：Windows10，Node v24.17.0，安装路径 D:\DevTools\Language\NodeJS
现象：
1. 打开CMD，直接输出报错：`文件名、目录名或卷标语法不正确。`
2. `node -v` 可以正常输出版本号；但执行npm相关命令（npm update、npm ls -g）都会触发同样报错。
3. 附带npm警告：`invalid config depth=="=0"`，属于参数书写错误。

## 核心结论
1. 报错根本原因：**系统环境变量PATH中存在CMD无法解析的非法路径**（最常见是包含波浪号`~`，fnm/nvm工具会自动注入这类路径，CMD原生不支持`~`简写路径，PowerShell无此限制）。
2. 次要问题：npm自身config里prefix/cache缓存路径配置非法，会继续触发报错。
3. 附加小问题：npm命令参数书写错误，`--depth==0`多写了一个等号。

## 关键知识
- Windows CMD 不识别 `~` 用户目录简写，PowerShell、Windows终端支持。
- 环境变量PATH里面的路径**不能自带双引号**，带引号会导致解析失败。
- npm全局模块路径prefix、cache目录如果配置非法，所有npm子命令都会报错，但node本体不受影响。
- CMD的注册表AutoRun启动项，配置错误路径也会在CMD打开瞬间直接抛出该错误。

## 有效修复方案（按顺序执行）
### 1. 清理环境变量PATH非法路径
1. Win+R，输入 `sysdm.cpl` → 高级 → 环境变量
2. 分别检查【用户变量PATH】和【系统变量PATH】
3. 删除以下类型非法条目：
   - 包含波浪号`~`的路径
   - 路径自带双引号 `"xxx"`
   - 不存在的盘符、路径末尾多余斜杠、包含`< > | "`非法字符
4. 保留node干净路径：
```

   D:\DevTools\Language\NodeJS   C:\Users\ggbdpq\AppData\Roaming\npm

```
5. 保存全部设置，关闭所有CMD窗口，重新打开。

### 2. 重置npm全局路径配置
新开CMD执行：
```bash

### 有效修复方案（按顺序执行）

### 1. 清理环境变量PATH非法路径
1. Win+R，输入 `sysdm.cpl` → 高级 → 环境变量
2. 分别检查【用户变量PATH】和【系统变量PATH】
3. 删除以下类型非法条目：
   - 包含波浪号`~`的路径
   - 路径自带双引号 `"xxx"`
   - 不存在的盘符、路径末尾多余斜杠、包含`< > | "`非法字符
4. 保留node干净路径：
```

   D:\DevTools\Language\NodeJS   C:\Users\ggbdpq\AppData\Roaming\npm

```
5. 保存全部设置，关闭所有CMD窗口，重新打开。

### 2. 重置npm全局路径配置
新开CMD执行：
```bash

### 4. 兜底修复方案

1. 重建npm目录：手动删除 `C:\Users\ggbdpq\AppData\Roaming\npm` 和 `npm-cache` 文件夹，重新执行npm config set命令。
2. 重装Node：下载同版本Node安装包覆盖安装，保持原有安装目录。
3. 注册表检查AutoRun（CMD一打开就报错优先试这个）： Win+R输入regedit，定位： `HKEY_CURRENT_USER\Software\Microsoft\Command Processor` 如果存在AutoRun项，直接删除。

### 踩坑与错误认知

❌ 误区：node能正常运行，说明环境变量没问题

> node命令单独读取PATH找到node.exe，但是CMD在初始化阶段会一次性加载全部PATH，PATH里面任意一条非法路径，打开CMD就报错，不影响node本身调用。

❌ 误区：直接重装node就能解决

> 如果PATH里面还保留非法路径，重装Node不会清理旧PATH，问题依旧。

### 后续建议

1. 日常开发推荐切换Windows终端，规避CMD对波浪号路径不兼容的问题。
2. 修改环境变量后**必须关闭全部CMD窗口**，旧终端不会读取新环境变量。
3. 排查这类CMD初始化报错优先检查PATH，其次检查注册表AutoRun。

```
上面是Markdown完整内容，你可以直接复制保存成对应的中文文件名 `.md` 文件。
```

### 来源：Visual Studio生成工具安装Win11 SDK 10.0.26100安装失败问题排查方案.md

### 核心结论

1. 报错根源**不是Visual Studio生成工具版本**，而是**新版VS Installer组件源会强制推送预览版Windows 11 SDK(10.0.26100)**；哪怕安装VS2022，只要用最新版VS Installer，依然会加载这个预览SDK组件，触发下载失败警告。
2. 解决方案核心思路：**取消勾选10.0.26100预览SDK，改用稳定正式版Win11 SDK 10.0.22621**，日常编译完全够用。
3. 警告提示“安装已完成，但出现警告”：代表编译主体组件已经装好，仅预览SDK组件失败；但建议清理掉失败组件消除警告，避免后续编译环境异常。

### 背景与问题

在安装Visual Studio生成工具（先后尝试2026版、2022版）时，VS Installer持续报错：**无法安装 Win11SDK_10.0.26100**。 现象：更换VS大版本（从2026换到2022），依然出现完全相同的SDK报错。 目标：解决SDK安装警告，获取可用的C++编译生成工具，用于node-gyp、C/C++项目编译。

### 有效方案（按优先顺序）

### 方案1：图形界面移除预览SDK（首选）

1. 在VS Installer主界面选中【Visual Studio 生成工具2022】，点击**修改**，弹出完整安装配置窗口。
2. 在弹窗顶部切换标签至【单个组件】。
3. 搜索框输入`10.0.26100`，取消所有匹配到的`Windows 11 SDK (10.0.26100)`勾选。
4. 搜索`10.0.22621`，确认勾选稳定版Windows 11 SDK。
5. 点击右下角【修改】执行更新，完成后警告消失。

### 方案2：清理缓存与残留文件（图形界面操作失败时使用）

1. 完全关闭VS Installer所有窗口。
2. 管理员终端执行清理命令：

```
rd /s /q %ProgramData%\Package Cache
rd /s /q %temp%\vs_installer
```

1. 控制面板 → 程序和功能，卸载所有`Windows SDK 10.0.26100`相关条目。
2. 重启电脑，再执行方案1。

### 方案3：离线安装，直接剔除预览SDK（兜底方案，绕开在线下载故障）

1. 下载VS2022生成工具在线引导程序 `vs_buildtools.exe`
2. 新建本地离线目录，例如`D:\VS2022Offline`
3. 管理员CMD执行命令，仅下载C++编译组件，排除问题SDK：

```
vs_buildtools.exe --layout D:\VS2022Offline --add Microsoft.VisualStudio.Workload.VCTools --remove Microsoft.Windows.SDK.10.0.26100
```

1. 下载完成后，进入离线目录运行`setup.exe`完成安装。

### 方案4：单独手动安装稳定SDK

直接从微软官网独立下载Windows 11 SDK 10.0.22621，手动安装，再回到VS Installer取消26100组件勾选。

### 踩坑与错误认知

❌ 错误认知：更换VS大版本（2026→2022）就能解决SDK报错。 ✅ 事实：VS Installer独立更新，组件源共用，只要不取消预览SDK勾选，换版本依旧报错。

### 后续建议

1. 优先执行方案1图形界面操作，操作最简单；如果反复失败，走离线安装方案。
2. 安装完成后，打开终端执行`node-gyp`或者C++编译测试，验证编译链可用。
3. 后续更新VS生成工具时，留意单个组件页面，避免自动勾选26100预览SDK。

------

> 文档说明：本记录用于Windows开发环境搭建，node-gyp、C++编译环境故障排查复用。

你可以直接复制全部内容，粘贴保存为 `Visual Studio生成工具安装Win11 SDK 10.0.26100安装失败问题排查方案.md`。

是否需要我再精简一份**极简操作速查版**放在文档末尾，方便以后快速查阅？

### 来源：Win11 Git配置代理解决提交推送至远程仓库失败问题.md

### 核心结论

Git推送远程仓库失败，在本机有代理的场景下，为Git单独配置代理后即可正常完成提交推送。

### 背景与问题

- 环境：Windows11，本地Git，开启代理
- 现象：本地最新提交push推送到远程仓库失败，属于网络层面连通问题

### 有效方案

1. 测试代理连通性
2. 根据本地代理协议，为Git设置http/https代理配置
3. 配置完成后执行git push推送

### 踩坑与错误认知

- ❌ 误区：系统开了代理，Git就会自动走代理。
- ✅ 事实：Git不会自动继承系统代理，必须单独配置Git的代理参数，否则依然直连远程仓库，出现超时推送失败。

### 后续建议

1. 可按需保存/取消Git代理（不需要代理的时候记得清除git代理配置，避免离线或切换网络时报错）
2. 备选兜底方案：切换SSH协议方式拉取推送代码

------

建议保留：该内容属于Git网络排错可复用实操方案，后续遇到同类推送失败场景可以直接复用这套排查步骤。

是否需要我帮你精简成一行复制命令清单版本，追加到这份md末尾？

### 来源：VSCode Git报错 Permission denied (publickey) GitHub SSH公钥权限问题排查与修复.md

### 核心结论

报错本质：**SSH 密钥认证失败**，本地缺少已添加到 GitHub 账号的有效 SSH 公钥。有两套解决方案：

1. 快速方案：将仓库远程地址切换为 HTTPS，不用配置 SSH 密钥；
2. 长期推荐：生成并配置 SSH 密钥，实现免密码操作 GitHub。

### 背景与问题

在 VSCode 操作 GitHub 开源仓库时弹出报错：`Git: git@github.com: Permission denied (publickey)`，仓库使用 SSH 地址连接，无法拉取/推送代码，SSH 公钥校验失败。

### 有效方案

### 方案1：切换HTTPS（快速修复，优先应急使用）

1. 查看当前远程仓库地址

```
git remote -v
```

1. 修改origin远程地址为HTTPS链接

```
git remote set-url origin [https://github.com/](https://github.com/)你的GitHub用户名/仓库名.git
```

> 后续push/pull需要输入GitHub账号 + Personal access token作为密码。

### 方案2：配置SSH密钥（长期免密）

1. 检查本地是否存在SSH密钥

```
ls ~/.ssh
```

存在 `id_ed25519` / `id_rsa` 以及 `.pub` 文件代表已有密钥。

1. 生成SSH密钥（无密钥时执行，邮箱替换为GitHub绑定邮箱）

```

### 踩坑与错误认知

1. ❌ 错误：把公钥添加到单个仓库页面。✅ 正确：公钥添加到个人账号SSH设置，作用于该账号下所有仓库；
2. ❌ 错误：复制公钥时少字符、多空格、换行；✅ 正确：完整复制整段文本；
3. ❌ 错误：测试SSH成功后，VSCode依然报错。✅ 解决：重启VSCode；
4. ❌ 混淆SSH地址和HTTPS地址，改地址时写错链接。

### 后续建议

1. 个人开发电脑推荐配置SSH，省去每次输入令牌的操作；
2. HTTPS方式需提前在GitHub生成Personal access token，保存好令牌，丢失不可找回；
3. 密钥文件做好备份，不要泄露私钥（`id_ed25519`不带.pub的文件是私钥，禁止上传、分享）。

> 说明：该文档为可复用的开发排障笔记，后续再次遇到GitHub SSH权限拒绝报错可直接查阅。

------

是否需要我把这份 Markdown 文本直接输出纯文本，你复制保存成 `.md` 文件即可？

### 来源：Git stash储藏指定文件踩坑与实操方案.md

### 核心结论

1. `git stash push` 写文件名时，**必须写完整相对路径**，不能只写文件名；文件在config目录下，直接写`.proxy.js`会找不到。
2. `git stash push` 默认**不会储藏未追踪(Untracked)的新文件**，需要加 `-u` 参数。
3. 简单场景优先使用`git stash save -u`一次性储藏全部变更，避免路径写错。

### 背景与问题

在VSCode + Git(MINGW64)环境，需要将4处代码变更储藏（stash），而不是commit提交。 文件清单：

1. `.gitignore`（M，已追踪，修改）
2. `AGENTS.md`（U，未追踪新文件）
3. `config/.proxy.js`（U，未追踪新文件）
4. `config/dev.js`（M，已追踪，修改）

尝试执行命令：

```
git stash push .gitignore AGENTS.md .proxy.js dev.js -m "临时保存本地开发常见目录"
```

报错：`pathspec ... did not match any file(s) known to git`

### 有效方案

### 方案1：推荐，一次性储藏全部变更（适配本次场景，最简单）

```
git stash save -u -m "临时保存本地 agents 技能目录"
```

> `-u` 自动包含所有未追踪新文件+已修改文件，不用关心路径，一次性把4个文件存入储藏。

### 方案2：精准储藏指定文件（补全目录路径）

```
git stash push config/.proxy.js config/dev.js .gitignore AGENTS.md -u -m "临时保存本地 agents 技能目录"
```

### 方案3：已经执行过git add .，暂存区已有文件，直接stash

```
git stash -m "临时保存本地 agents 技能目录"
```

### 配套常用stash管理命令

```

### 《Git stash储藏指定文件踩坑与实操方案.md》

## 背景与问题

在VSCode + Git(MINGW64)环境，需要将4处代码变更储藏（stash），而不是commit提交。 文件清单：

1. `.gitignore`（M，已追踪，修改）
2. `AGENTS.md`（U，未追踪新文件）
3. `config/.proxy.js`（U，未追踪新文件）
4. `config/dev.js`（M，已追踪，修改）

尝试执行命令：

```
git stash push .gitignore AGENTS.md .proxy.js dev.js -m "临时保存本地开发常见目录"
```

报错：`pathspec ... did not match any file(s) known to git`

## 核心结论

1. `git stash push` 写文件名时，**必须写完整相对路径**，不能只写文件名；文件在config目录下，直接写`.proxy.js`会找不到。
2. `git stash push` 默认**不会储藏未追踪(Untracked)的新文件**，需要加 `-u` 参数。
3. 简单场景优先使用`git stash save -u`一次性储藏全部变更，避免路径写错。

## 关键知识

- `git stash`：储藏工作区改动，不提交到版本链，临时存放切换分支前的本地修改。
- `-u / --include-untracked`：包含未追踪的新增文件（U标记文件）。
- `git stash push`：选择性储藏**部分文件**，适合只储藏部分改动，要求文件路径准确。
- `git stash save`：传统储藏命令，适合一次性储藏所有变更。

## 有效方案

### 方案1：推荐，一次性储藏全部变更（适配本次场景，最简单）

```
git stash save -u -m "临时保存本地 agents 技能目录"
```

> `-u` 自动包含所有未追踪新文件+已修改文件，不用关心路径，一次性把4个文件存入储藏。

### 方案2：精准储藏指定文件（补全目录路径）

```
git stash push config/.proxy.js config/dev.js .gitignore AGENTS.md -u -m "临时保存本地 agents 技能目录"
```

### 方案3：已经执行过git add .，暂存区已有文件，直接stash

```
git stash -m "临时保存本地 agents 技能目录"
```

### 配套常用stash管理命令

```

### 踩坑与错误认知

1. ❌ 错误：直接写文件名，忽略文件夹路径。 ✅ 正确：VSCode里文件名后面标注`config`，代表文件在config子目录，写命令要带上目录前缀。
2. ❌ 错误：`git stash push`不加 `-u`，以为能自动保存新增U文件。 ✅ 正确：push默认只处理已追踪文件，新增未追踪文件必须加 `-u`。
3. ❌ 混淆`git add`（暂存到git索引）和`git stash`（储藏工作区变更）两个概念。

### 后续建议

- stash适合临时保存，不要长期大量堆积多条stash，用完及时pop清理。
- 若储藏内容很重要，建议后续还是commit提交到分支，stash只是临时缓冲，清理仓库时可能丢失。

------

我已经整理好这份Markdown文档内容，你可以复制全部内容，本地保存为 `Git stash储藏指定文件踩坑与实操方案.md`。

需要我把文档内容压缩成一行精简笔记版本，方便存到obsidian/语雀吗？

### 来源：Windows桌面右键菜单清理（移除失效IDE残留右键项）.md

### 核心结论

桌面空白右键菜单的配置项存储在注册表 `Directory\Background\shell` 路径，清理有两种方案：**优先使用可视化工具ContextMenuManager（安全，推荐）；其次手动修改注册表（适合熟悉Windows注册表的用户）**。

### 背景与问题

Windows桌面空白处右键菜单存在大量失效的「通过XXX打开」菜单项（Cursor、Trae、Antigravity、Kiro、Qoder等IDE工具残留），软件卸载后注册表右键项没有自动清除，造成右键菜单臃肿杂乱。

### 有效方案

### 方案1：ContextMenuManager 可视化工具（推荐）

1. 从GitHub下载开源免安装工具 ContextMenuManager

2. 打开软件，切换分类到【桌面背景】

3. 在列表选中无效条目：`通过 Antigravity 打开`、`通过 Trae 打开`、`通过 Kiro 打开`、`通过 Qoder 打开`等

4. 操作：**优先点【禁用】**（可随时恢复，风险最低），确认效果没问题后，再执行删除。

   > Git Bash、Git GUI、Warp终端右键项，同样可在这里隐藏/删除。

### 方案2：手动注册表清理（谨慎操作）

1. `Win+R`，输入 `regedit`，打开注册表编辑器
2. 地址栏粘贴路径跳转：

```
HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell
```

1. 在左侧树中，删除对应IDE名称的子项（只删除已卸载软件对应的文件夹，不要修改系统自带项）
2. 生效步骤：`Ctrl+Shift+Esc` 打开任务管理器，找到「Windows资源管理器」右键【重启】，桌面右键菜单立刻刷新。

### 踩坑与错误认知

❌ 误区：直接在控制面板卸载软件就能自动清理全部右键菜单。 ✅ 事实：很多开发工具卸载脚本不会清理 `Directory\Background\shell`，会遗留右键菜单项。 ❌ 误区：随便删除注册表内未知项目。 ✅ 风险：误删系统自带shell项，会导致右键功能异常。

### 后续建议

以后安装Cursor、Trae、Qoder这类AI IDE，卸载完成后可以检查右键菜单，及时清理残留； ContextMenuManager可以作为常备Windows系统小工具，统一管理各类右键菜单。

------

> 文件名称：《Windows桌面右键菜单清理（移除失效IDE残留右键项）.md》

需要我把这个Markdown原文直接给你复制，保存成本地文件吗？

### 来源：Windows右键菜单残留无效开发工具项清理方案.md

### 核心结论

该报错根源是软件卸载后，注册表内文件夹上下文菜单的注册表项没有自动删除，需要清理注册表对应项，或使用第三方右键管理工具移除残留条目；操作完成后重启资源管理器即可生效。

### 背景与问题

Windows文件夹空白处右键菜单，残留5个已卸载/路径失效的开发工具菜单项（通过Antigravity打开、通过CodeBuddy打开、通过Lingma打开、通过Qoder打开、通过Trae打开），点击弹出`Explorer.EXE 找不到应用程序`报错弹窗，需要删除无效右键菜单条目，保留Cursor、Git、Warp、VSCode等正常菜单。

### 有效方案

### 方案1：注册表编辑器（推荐，彻底清除）

1. `Win+R`，输入`regedit`回车，打开注册表编辑器。
2. 定位路径：`HKEY_CLASSES_ROOT\Directory\shell`
3. 在左侧`shell`目录，找到以下5个注册表项，逐个右键删除：
   - 通过 Antigravity 打开
   - 通过 CodeBuddy 打开
   - 通过 Lingma 打开
   - 通过 Qoder 打开
   - 通过 Trae 打开
4. 重启资源管理器：
   - `Ctrl+Shift+Esc`打开任务管理器
   - 找到`Windows资源管理器`，右键选择【重启】

### 方案2：第三方工具一键清理（免手动改注册表）

1. ShellExView：打开后勾选`Hide All Microsoft Extensions`，过滤第三方菜单，找到对应条目禁用/删除。
2. CCleaner：工具 → 启动项 → 上下文菜单，勾选无效条目，执行删除。

### 方案3：修复（不删除，可选）

若后续重装软件，可保留注册表项，修改子项`command`的默认值，填入软件exe完整路径即可恢复菜单。

### 踩坑与错误认知

❌ 误区：直接删除快捷方式文件就能移除右键菜单 ✅ 真相：这类“通过XX打开”是注册表注册的上下文菜单，不是普通快捷方式，删除exe/快捷方式不会清理注册表，菜单会一直残留，点击就报找不到程序。

### 后续建议

1. 删除注册表项后，先在文件夹空白右键测试，确认5个条目消失，不再弹出报错。
2. 修改注册表前，可以右键对应注册表项【导出】做备份，万一误删可以双击备份文件恢复。

------

是否需要我把这份文档精简成纯操作速查表版本，方便以后快速查阅？

### 来源：网站与服务器部署端口号范围及选型规范.md

### 核心结论

端口为16位无符号整数，总范围 0 ~ 65535，IANA分为三类；**自建网站/业务服务优先选用 1024~49151 注册端口**；公网正式网站使用标准80（HTTP）、443（HTTPS）。49152~65535不建议用来监听服务，容易产生端口冲突。

### 背景与问题

搭建网站、部署服务器时，需要明确TCP/UDP端口的合法取值范围、端口分段规则，以及建站场景下端口的选择原则、禁忌事项。

### 有效方案

1. 公网正式网站：使用80（HTTP）、443（HTTPS），访问地址无需携带端口；需同步放行云服务器安全组与操作系统防火墙。
2. 内部测试、多站点、开发环境：从1024–49151区间挑选端口，推荐 3000、8080、8081、8090、9000、18080。

### 踩坑与错误认知

1. 误区：随便选用49152以上端口部署服务。风险：该段是客户端临时出站端口，容易发生端口抢占冲突。
2. 误区：随意占用0~1023区间端口。风险：需要管理员权限，且容易和系统自带基础服务冲突。

### 后续建议

部署前检查端口占用；上线公网网站优先配置HTTPS（443端口）；数据库、远程SSH等管理端口不要直接暴露公网。
```

你可以复制上面全部内容保存为md文件。 是否需要我把内容精简一版，做成适合快速检索的极简笔记版本？

## 使用建议

- 后续继续开发或研究时，先以实际代码、最新接口契约、官方文档和运行证据复核本文中的时效性事实。
- 新对话只补充新增结论或修正文档已有结论，避免再次创建同主题平行文档。

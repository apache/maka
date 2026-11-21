# 09 · openclaw：38 万星的"个人助理"边界案例

> 引擎层（边界案例：通用个人助理，非编码专用） ｜ Stars ~388.8k（2026-09-04，全生态最高） ｜ TypeScript ｜ 许可证为自定义文本（GitHub 未标注 SPDX，商用前读 LICENSE） ｜ [openclaw/openclaw](https://github.com/openclaw/openclaw)
> 学习目标：搞清它为什么不在编码工具序列里却必须认识；理解"gateway + IM 入口 + skills"的助理架构。

## 一、为什么存在

一句话：**跑在你自己设备上、活在你聊天软件里的个人 AI 助理**——"Your assistant, on your devices, in your chats"。它不是编码 agent，但它是这个生态 star 数最高的项目（38.8 万），且与编码工具共享同一套底层词汇（MCP 工具、skills、多模型接入）。把它放进地图的原因：**你必须能向别人解释它和编码 agent 的边界**，否则讨论"AI 工具"时最容易张冠李戴。

血统上它承自 2025 年的 Clawdbot/Moltbot 一系，2026 年成为独立品牌。README 专设 Security 章节——一个能读你消息、执行命令的常驻助理，安全模型是核心议题。

## 二、快速入门

macOS/Linux/WSL2：

```bash
curl -fsSL <安装脚本，见仓库 README Install 节> | bash
```

Windows 有对应 PowerShell 安装。第一次跑通：安装 → 在终端初始化并配模型 → 把它接进你常用的聊天软件（Telegram 等）→ 手机上发一句"帮我看看今天的日程"。**建议在专用设备或隔离环境里试**，不要一上来接主力机。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Gateway | 常驻本地/自托管的助理服务，一切入口的汇聚点 |
| IM 入口 | WhatsApp/Telegram 等聊天软件即客户端 |
| Skills | 技能包，能力扩展的主要形式 |
| 设备同步 | 助理状态跨你的设备存在 |
| Security 模型 | 谁能让它干什么——使用前必须读完 |

熟练判断：它适合"个人助理"需求；如果你要的是"帮我写代码"，本目录 01-08 才是对口工具，别拿 openclaw 硬写码。

## 四、架构设计

巨型 monorepo：`src/`（核心）、`apps/` 与 `packages/`（各端与组件）、`extensions/` 与 `skills/`（能力扩展）、`ui/`、`deploy/`、`security/`。

架构本质是 **gateway 模式**：一个常驻服务持有模型接入与会话状态，IM、终端、语音都是它的前端；能力以 skills/extensions 热插拔。这与 opencode 的 client/server 思路同源，但把"客户端"极端化成了你手机里的聊天窗口。学习重点：**常驻 agent 的安全边界设计**（它在你的私聊里，谁能冒充你下指令？）。

## 五、源码地图与阅读路线

| 目录 | 职责（部分为推断，以仓库文档为准） |
| --- | --- |
| `src/` | 核心引擎与 gateway |
| `apps/`、`packages/` | 各端应用与共享组件 |
| `extensions/`、`skills/` | 能力扩展体系 |
| `security/`、`docs/` | 安全模型与文档 |

建议顺序：先读 `docs/` 与 Security 章节 → gateway 的会话与鉴权流 → 一个最简 skill 的完整生命周期。它代码量大，别通读，按问题查。

## 六、自测清单

- [ ] 能用三句话说清 openclaw 与编码 agent 的区别
- [ ] 解释 gateway 模式与"单次会话 CLI"的架构差异
- [ ] 说出它的两个安全风险点及 README 给出的对策
- [ ] 知道它的许可不是标准开源协议，商用前要读什么

## 七、参考

- 仓库：<https://github.com/openclaw/openclaw>
- 文档：仓库 `docs/` 目录与官网（见 README）

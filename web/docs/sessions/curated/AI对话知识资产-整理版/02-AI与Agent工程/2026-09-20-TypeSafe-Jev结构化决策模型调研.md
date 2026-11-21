# 03-TypeSafe-Jev结构化决策模型调研

> 由 1 份 AI 对话沉淀合并。整理目标是保留可复用事实、决策与验证结果，压缩聊天过程。

## 核心沉淀

- Jev 在该次调研中被定位为结构化决策模型：输入 state 与类型化问题，输出概率/置信度，不以自由文本生成作为核心能力。
- 适合分类、路由、打分、守卫等低延迟、代码直接消费的决策节点；复杂开放式推理与长文本生成不属于其主要边界。
- 文档中的价格、速度和 early access 能力均具有时效性，后续使用前必须重新核对官方文档。

## 来源与整合内容

### 来源：TypeSafe Jev 结构化决策模型调研与上手.md

### 二、最终结论（TL;DR）

1. **Jev 不是聊天模型**：它是 TypeSafe 的首个 "System One Model"（系统一模型），输入一段 state（状态文本）+ 一组类型化问题，输出**带校准概率/置信度的结构化决策**，完全没有文本生成。名字取自 Kahneman 的"系统一思维"和经济学家 Jevons。
2. **定位是 LLM 工作流里的"智能 if 语句"**：分类、路由、打分、真伪判断、LLM 输出守卫这类高频、重复、需要代码直接消费结果的决策。
3. **核心卖点**：端到端 70–500ms（官方称比前沿 LLM 快 40–200 倍，官网营销口径 193.6x faster / 444.6x cheaper）；定价 $42/十亿输入 token（$0.042/MTok），**输出 token 免费**；输出类型安全，官方称"零幻觉"。
4. **三个链接的性质**：
   - `console.typesafe.ai/home` — 控制台，登录墙（Google OAuth 或邮箱验证码），登录后才能用。
   - `console.typesafe.ai/playground` — 网页版零代码试用界面，同样在登录墙后。
   - `jev-trader.vercel.app` — 低延迟演示站：在 Monad 链上每出一个区块就让 Jev 决策一次买/卖（向 Kuru 的 MON/USDC 订单簿发 bid 或 ask），页面实时显示 block 号、决策耗时（last/avg ms）、calls、fills、uptime。**纯围观 demo，无交互入口，不是产品**。

### 一、问题背景与目标

- 背景：Jev 在对话时点（2026-09-20 前 1–2 天）刚发布即爆火，TypeSafe AI 为 OpenAI 元老创办、获 $40M 种子轮（inside.com.tw 报道）。用户拿到三个链接（`console.typesafe.ai/home`、`console.typesafe.ai/playground`、`jev-trader.vercel.app`），点开全是登录页或看不懂的演示，不知道"这东西是什么、怎么开始用"。
- 目标：弄清 Jev 的定位、三个链接各自的作用，以及从注册到代码调用的完整上手路径。

### 三、上手路径（已核实）

1. **注册**：打开 <https://console.typesafe.ai/home>，Google 登录或邮箱收验证码。注意 early access 阶段官方说法是"从 waitlist 逐步放行"，登录成功 ≠ 立即可用。
2. **Playground 试用**：<https://console.typesafe.ai/playground>，零代码验证三种原语的返回效果。
3. **拿 API Key**：<https://console.typesafe.ai/settings/keys>，设为环境变量 `TYPESAFE_API_KEY`。
4. **调用 API**：

REST（官方 Quick Start 原样）：

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "state": "Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing. I'm losing sales. Please help ASAP.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "The message conveys urgency or time-sensitivity"
    }
  }
}
EOF
```

Python SDK（要求 Python ≥3.10）：

```bash
pip install typesafe-sdk   # 或 uv add typesafe-sdk
```

```python
from typesafe_sdk import Choice, Score, Noul, TypeSafeClient

client = TypeSafeClient()  # 自动读 TYPESAFE_API_KEY，默认模型 jev-latest
resp = client.system_one(
    state="Hi, I've been trying to connect my Stripe account for 3 days...",
    questions={
        "department": Choice(instructions="Which team should handle this",
            criteria={"billing": "Payment or subscription issues",
                      "technical": "Bugs or integration problems",
                      "sales": "Pricing or account questions"}),
        "frustration": Score(instructions="How frustrated the customer appears",

> 此节原文较长，已在整理版中截取关键部分。

### 六、调查过程中的踩坑与可迁移经验

1. **登录墙识别**：`console.*` 域下 `/home` 和 `/playground` 两个路径都返回同一张 "Welcome to TypeSafe" 登录页 → 判定整个控制台需登录，抓取工具看不到登录后内容。对 SaaS 产品的调研不能指望从 console 域拿功能信息，应转向官网/博客/公开 docs。
2. **抓取工具降级链**：WebFetch 对 `jev-trader.vercel.app` 连续两次 `ECONNRESET`，换 `webReader` MCP 工具一次成功。Vercel 站点对某类 UA/代理易重置连接，工具间切换即可解决，不是站点挂了。
3. **文档站导航法**：`docs.typesafe.ai` 的 Introduction 页不含实操细节，但页面自报了完整索引 `https://docs.typesafe.ai/llms.txt` 和 Quick Start 路径 `/introduction/quickstart`——顺着文档自述的索引定位，比盲猜 URL 快。
4. **搜索摘要日期矛盾处理**：一条搜索摘要写"2025年9月中旬发布"，另两条写"22 小时前 / 2 days ago"，与当前日期（2026-09-20）对照后判定发布时间为 2026-09-18 前后，"2025"为转述误差。相对时间 + 当前日期交叉验证优于直接采信单条摘要。
5. **信息源分层**：产品事实（API、定价、原语）以官方 docs/博客为准；第三方文章只用于背景（融资、热度）；demo 站只用于理解展示意图，不当作功能承诺。

### 八、已完成事项

- 确认三个链接各自性质（登录墙 ×2、围观 demo ×1），解开"怎么全是登录页"的困惑。
- 从官方 docs 抓全 REST 与 Python SDK 的完整调用方式、请求/响应结构、三种原语语义。
- 明确 Jev 的适用/不适用边界、定价、early access 状态。
- 输出可执行的上手路径（注册 → Playground → Key → API/SDK → agent skill）。

### 九、遗留问题与待验证假设

- **waitlist 放行节奏未验证**：登录成功后能否立即调用 API、是否所有新账号都先进候补名单——需注册后实测。
- **免费额度未知**：对话中未查到任何免费 quota 信息，接入成本评估前需在控制台确认。
- **TypeScript SDK 安装命令未获取**：docs 的 `/sdk` 页面本次未抓取。
- **性能与校准质量未经独立验证**：官方倍数与"零幻觉"均为厂商口径；`confidence` 的实际校准度（是否真能按阈值分流人工审核）需用自己的数据测。
- **分类基数 >255 的两阶段方案细节**：博客只提了限制，具体模式未在本次抓取范围内。

## 使用建议

- 后续继续开发或研究时，先以实际代码、最新接口契约、官方文档和运行证据复核本文中的时效性事实。
- 新对话只补充新增结论或修正文档已有结论，避免再次创建同主题平行文档。

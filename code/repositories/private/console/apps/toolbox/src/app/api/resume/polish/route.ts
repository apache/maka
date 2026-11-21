import { NextResponse } from "next/server";

/**
 * AI 润色（R5）：DeepSeek 服务端代理。key 只在服务端读取；
 * GET 探活（key 是否配置），POST { action: "polish" | "draft", text, title?, subtitle? }。
 * 上游硬编码官方端点（防 SSRF：不引入任何可配置的请求目标）。
 */
const UPSTREAM = "https://api.deepseek.com/chat/completions";

export async function GET() {
  return NextResponse.json({ available: Boolean(process.env.DEEPSEEK_API_KEY) });
}

const SYSTEM_PROMPT = `你是资深简历顾问。规则：
1. 只优化表达，绝不编造用户没写的事实；缺失数据用〔量化〕占位符提示用户补填。
2. 输出纯 Markdown 无序列表（- 开头），可使用 **加粗**；不输出解释、前后缀或代码块标记。
3. 风格参照（挑战→方案→结果叙事）：
- ■ **核心挑战**：业务复杂、链路长、稳定性要求高
- ■ **关键设计与实践**：
  - 主导 X，落地 Y
  - 设计 Z 机制，保证 W
- ■ **结果与影响**：
  - 核心指标提升〔N%〕
  - 沉淀可复用方案，被 M 个模块复用
4. 每条要点动词开头，量化数据优先保留用户原文数字。`

export async function POST(req: Request) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "未配置 DEEPSEEK_API_KEY（apps/console/.env.local）" },
      { status: 503 },
    );
  }
  let body: { action?: string; text?: string; title?: string; subtitle?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不合法" }, { status: 400 });
  }
  const { action = "polish", text = "", title = "", subtitle = "" } = body;
  if (!text.trim() && action === "polish") {
    return NextResponse.json({ ok: false, error: "没有可润色的内容" }, { status: 400 });
  }

  const user =
    action === "draft"
      ? `为以下经历生成三段式简历要点草稿（核心挑战/关键设计与实践/结果与影响）：
公司/项目：${title}
职位/角色：${subtitle}
已知信息：${text || "（无，基于标题合理推断结构，事实处用〔量化〕占位）"}`
      : `润色以下简历要点（保留全部事实与数字，只改表达；弱动词换强动词；缺数据处加〔量化〕占位）：\n${text}`;

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0.4,
      }),
      signal: req.signal,
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      return NextResponse.json(
        { ok: false, error: `上游 ${upstream.status}：${detail.slice(0, 120)}` },
        { status: 502 },
      );
    }
    const data = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = data.choices?.[0]?.message?.content?.trim();
    if (!out) return NextResponse.json({ ok: false, error: "模型返回为空" }, { status: 502 });
    return NextResponse.json({ ok: true, text: out });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "调用失败" },
      { status: 502 },
    );
  }
}

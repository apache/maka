// 六期并入：interview-gym 的 proxy.mjs（8787 独立进程）按单进程宪法改为 route handler。
// 协议不变：POST /api/interview-gym/relay/<原路径>，头 x-llm-target 指真实 Base URL；
// Key 仍由浏览器带在请求头里，本端点不落盘。请求体小（prompt JSON）整读，响应体（SSE）透传。
import { NextRequest, NextResponse } from "next/server";

// 只允许转发到主流大模型 API，防止被当通用代理滥用
const ALLOWED_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "api.deepseek.com",
  "open.bigmodel.cn",
  "api.moonshot.cn",
  "openrouter.ai",
  "api.siliconflow.cn",
  "api.x.ai",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
  "localhost",
  "127.0.0.1",
]);

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "origin",
  "referer",
  "cookie",
  "accept-encoding",
  "x-llm-target",
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const target = req.headers.get("x-llm-target");
  if (!target || !/^https?:\/\//.test(target)) {
    return NextResponse.json({ error: "缺少 x-llm-target 头（真实 Base URL）" }, { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(target + "/" + path.join("/"));
  } catch {
    return NextResponse.json({ error: `x-llm-target 不是合法 URL：${target}` }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return NextResponse.json({ error: `主机 ${url.hostname} 不在中继白名单` }, { status: 403 });
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    if (!HOP_HEADERS.has(key)) headers[key] = value;
  }

  try {
    const body = await req.arrayBuffer();
    const upstream = await fetch(url, { method: "POST", headers, body });
    const out = new Headers();
    for (const key of ["content-type", "cache-control"]) {
      const value = upstream.headers.get(key);
      if (value) out.set(key, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    return NextResponse.json({ error: `上游请求失败：${err instanceof Error ? err.message : err}` }, { status: 502 });
  }
}

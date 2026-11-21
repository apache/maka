/**
 * 内容导出 —— linkpull 文章路线（Go 版 internal/article + extract/generic）的 Node 承接：
 * 任意网页（含 B站专栏）readability 正文抽取 → Markdown；X 文字/图片推文走 fxtwitter 公开 API。
 * 裁剪声明：图片不本地化（保留原 URL）、B站高清登录走 yt-dlp --cookies-from-browser、弹幕 ASS 未承接。
 */
import { NextResponse } from 'next/server';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';


export const runtime = 'nodejs';

const DOWNLOAD_DIR =
  process.env.AGENT_DOWNLOADS_DIR ?? path.join(os.homedir(), 'Downloads', 'agent-downloads');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

interface FxTweet {
  text: string;
  author?: { name?: string; screen_name?: string };
  created_at?: string;
  media?: { all?: Array<{ type: string; url?: string; alt_text?: string }> };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: string } | null;
  const url = body?.url?.trim();
  if (!url) return NextResponse.json({ error: '缺少 url' }, { status: 400 });
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return NextResponse.json({ error: 'url 无法解析' }, { status: 400 });
  }

  let title: string;
  let markdown: string;

  if (/(^|\.)x\.com$/.test(u.hostname) && /\/status\/\d+/.test(u.pathname)) {
    // X 文字/图片推文：fxtwitter 公开 API（Go 版同路线）
    const statusId = u.pathname.match(/\/status\/(\d+)/)?.[1];
    const fx = await fetch(`https://api.fxtwitter.com/status/${statusId}`, {
      headers: { 'User-Agent': UA },
    }).then((r) => r.json() as Promise<{ tweet?: FxTweet }>);
    const tweet = fx.tweet;
    if (!tweet) return NextResponse.json({ error: 'fxtwitter 未返回推文内容' }, { status: 502 });
    title = `X · ${tweet.author?.name ?? tweet.author?.screen_name ?? statusId} · ${statusId}`;
    const parts = [tweet.text];
    const media = (tweet.media?.all ?? []).map((m) => m.url).filter(Boolean) as string[];
    if (media.length) parts.push(media.map((m) => `![媒体](${m})`).join('\n\n'));
    markdown = parts.join('\n\n');
  } else {
    // 任意网页（B站专栏 read/cv、opus、博客等）：readability 抽正文 → MD
    const html = await fetch(url, { headers: { 'User-Agent': UA } }).then((r) => {
      if (!r.ok) throw new Error(`源站返回 ${r.status}`);
      return r.text();
    });
    const doc = new JSDOM(html, { url });
    const article = new Readability(doc.window.document).parse();
    if (!article?.content) return NextResponse.json({ error: '未能抽取正文（页面可能是纯 JS 渲染或无正文）' }, { status: 422 });
    title = article.title || u.hostname;
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    markdown = turndown.turndown(article.content);
    markdown += `\n\n---\n> 来源：[${title}](${url}) · 导出于 ${new Date().toISOString().slice(0, 10)}\n`;
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const slug = (title || 'article').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
  const file = path.join(DOWNLOAD_DIR, `${slug}.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  return NextResponse.json({ title, file, chars: markdown.length });
}

/**
 * 下载台后端 —— spawn yt-dlp 执行下载任务。
 * linkpull（Go 版）退役后的能力承接：下载引擎不自研，直接驱动 yt-dlp 生态。
 * 任务态存内存（重启即清，ponytail: 持久化等真需要再加）；日志与产物落盘。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 下载目录可经 AGENT_DOWNLOADS_DIR 注入，默认 ~/Downloads/agent-downloads
const DOWNLOAD_DIR =
  process.env.AGENT_DOWNLOADS_DIR ?? path.join(os.homedir(), 'Downloads', 'agent-downloads');

type TaskState = 'running' | 'done' | 'failed';

interface Task {
  id: string;
  url: string;
  state: TaskState;
  startedAt: string;
  log: string[];
  file?: string;
}

const g = globalThis as typeof globalThis & { __downloadTasks?: Map<string, Task> };
const tasks = (g.__downloadTasks ??= new Map<string, Task>());

// 允许的平台域：下载台面向内容平台，不接受任意 URL 当代理
const ALLOWED_HOSTS = /(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|x\.com|twitter\.com)$/;

function ytDlpPath(): string | null {
  for (const p of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function GET() {
  return NextResponse.json({
    downloadDir: DOWNLOAD_DIR,
    ytDlp: ytDlpPath() ? 'ok' : 'missing',
    tasks: [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: string; quality?: string } | null;
  const url = body?.url?.trim();
  if (!url) return NextResponse.json({ error: '缺少 url' }, { status: 400 });
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return NextResponse.json({ error: 'url 无法解析' }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.test(host)) {
    return NextResponse.json({ error: `不支持的平台：${host}（当前允许 B站/YouTube/X）` }, { status: 400 });
  }
  const bin = ytDlpPath();
  if (!bin) {
    return NextResponse.json({ error: '本机未安装 yt-dlp（brew install yt-dlp ffmpeg）' }, { status: 503 });
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const task: Task = { id, url, state: 'running', startedAt: new Date().toISOString(), log: [] };
  tasks.set(id, task);

  const quality = body?.quality === 'audio' ? 'bestaudio' : `bestvideo[height<=${body?.quality ?? '1080'}]+bestaudio/best`;
  const child = spawn(bin, [
    url,
    '-f', quality,
    '--merge-output-format', 'mp4',
    '-o', path.join(DOWNLOAD_DIR, '%(title).80s.%(ext)s'),
    '--newline',
  ], { cwd: DOWNLOAD_DIR });

  child.stdout.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) task.log.push(line.trim());
    if (task.log.length > 500) task.log.splice(0, task.log.length - 500);
  });
  child.stderr.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) task.log.push(`[err] ${line.trim()}`);
  });
  child.on('close', (code) => {
    task.state = code === 0 ? 'done' : 'failed';
    task.log.push(code === 0 ? '== 完成 ==' : `== 退出码 ${code} ==`);
  });

  return NextResponse.json({ id });
}

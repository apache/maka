/**
 * ChatGPT Free 批量注册（Outlook 邮箱 + 锤锤 outlook007 API）。
 * 自 registration-toolkit/scripts/batch-email-register.ts 迁入：
 * - 引擎部件改从 @ggbdpq/register-core 引入
 * - 硬编码 API_KEY 改为环境变量 OUTLOOK007_API_KEY（不入库）
 * - 凭证文件/输出目录改为参数与环境变量注入
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CuiCuiMailProvider,
  OAuthClient,
  PuppeteerRealAdapter,
  generateIdentity,
  generatePassword,
  parseCredentialFile,
} from '@ggbdpq/register-core';
import type { AppConfig, CuiCuiCredential } from '@ggbdpq/register-core';

const API_BASE = 'https://ms.outlook007.cc';
const OAUTH_CID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_PORT = 1455;
const ACCOUNT_DELAY_MS = 30_000;
const MAIL_POLL_INT = 5_000;
const MAIL_POLL_MAX = 24;

export interface BatchEmailOptions {
  /** 锤锤 API key；缺省读 OUTLOOK007_API_KEY。 */
  apiKey?: string;
  /** Outlook 凭证文件（email----password----client_id----refresh_token 每行一个）。 */
  creds: string;
  /** 输出目录（token JSON 与日志）；缺省读 OUTLOOK007_OUT_DIR，再缺省 output/<日期>/。 */
  out?: string;
  /** 只跑前 N 个。 */
  count?: number;
  /** 起始序号（1 起）。 */
  start?: number;
}

interface RegisterResult {
  email: string; status: 'success' | 'failed'; outputPath?: string; error?: string;
  accountId?: string; planType?: string; durationMs: number;
}
interface BatchSummary { startedAt: string; finishedAt: string; total: number; success: number; failed: number; skipped: number; results: RegisterResult[]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function txt(snap: { text: string }): string {
  return snap.text.replace(/\s+/g, ' ').slice(0, 250);
}

function detect(s: { url: string; text: string; title: string; buttonLabels: readonly string[];
  inputs: ReadonlyArray<{ type: string; name?: string; placeholder?: string; visible: boolean }>;
  hasCfChallenge: boolean }): string {
  const t = (s.text + ' ' + s.title).toLowerCase();
  if (s.hasCfChallenge) return 'cf_challenge';
  if (s.inputs.some((i) => i.visible && i.type === 'password')) {
    if (/create.*password|new.*password|set.*password|choose.*password/i.test(t)) return 'password_create';
    return 'password_entry';
  }
  if (s.inputs.some((i) => i.visible && ((i.name || '').toLowerCase().includes('code') || (i.placeholder || '').toLowerCase().includes('code') || i.type === 'number'))) {
    return /verify.*email|email.*verif/i.test(t) ? 'email_verification' : 'code_entry';
  }
  if (s.inputs.some((i) => i.visible && (i.type === 'email' || (i.name || '').toLowerCase().includes('email'))) && /continue|next/i.test(t)) return 'email_entry';
  if (/sign\s*up|create\s*account|get\s*started/i.test(t)) return 'landing';
  if (/about\s*you|tell\s*us\s*about|your\s*name|full\s*name|birth/i.test(t)) return 'about_you';
  if (/authorize|allow\s*access/i.test(t) || s.url.toLowerCase().includes('authorize')) return 'authorize';
  if (/chat\s*gpt|new\s*chat|send\s*a\s*message/i.test(t) && s.url.includes('chatgpt.com')) return 'chatgpt_home';
  if (/something\s*went\s*wrong|try\s*again|content\s*failed/i.test(t)) return 'error_page';
  return 'unknown';
}

function makeLogger(logFile: string) {
  return (level: string, msg: string) => {
    const prefix = { info: '📌', warn: '⚠️', error: '❌', success: '✅' }[level] || '📌';
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = '[' + ts + '] ' + prefix + ' ' + msg;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  };
}

async function registerOne(cred: CuiCuiCredential, index: number, total: number, cuicui: CuiCuiMailProvider, outDir: string, log: (l: string, m: string) => void): Promise<RegisterResult> {
  const t0 = Date.now();
  const tag = '[' + index + '/' + total + '] ' + cred.email;
  log('info', tag + ' start');

  const miniCfg = { oauth: { clientId: OAUTH_CID, redirectPort: OAUTH_PORT, tokenOutputDirs: [outDir] } } as AppConfig;
  const oauth = new OAuthClient(miniCfg, null);
  const authUrl = oauth.getAuthUrl();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  const launchOpts = { headless: false as boolean, viewport: { width: 1280, height: 900 }, lang: 'en-US', userDataDir: sessionDir };
  const adapter = new PuppeteerRealAdapter();
  let chromePassword = '';
  let callbackUrl: string | null = null;

  try {
    await adapter.launch(launchOpts);
    await adapter.goto(authUrl, { waitForCf: true, timeoutMs: 90_000 });
    await sleep(3_000);

    // ── Step 0: 切到注册页 ──
    let snap = await adapter.snapshot();
    let state = detect(snap);
    log('info', tag + ' init: ' + state + ' | ' + txt(snap));

    const hasSignup = /sign\s*up|create\s*account|注册/i.test(snap.text.slice(0, 500));
    const hasPassword = snap.inputs.some((i) => i.visible && i.type === 'password');
    if (hasSignup && !hasPassword) {
      log('info', tag + ' click Sign up');
      try { await adapter.clickButtonByText('Sign up'); } catch { /* ok */ }
      await sleep(5_000);
      snap = await adapter.snapshot(); state = detect(snap);
      log('info', tag + ' reg: ' + state + ' | ' + txt(snap));
    }

    // ── Step 1: 邮箱 ──
    if (state === 'email_entry') {
      log('info', tag + ' type email: ' + cred.email);
      await adapter.type("input[type='email'],input[name='email'],input[name='username']", cred.email + '\n');
      await sleep(3_000);
      snap = await adapter.snapshot();
      state = detect(snap);
      log('info', tag + ' after email: ' + state + ' | ' + txt(snap));
    }

    // ── Step 2: 密码 ──
    if (state === 'password_entry' || state === 'password_create') {
      chromePassword = generatePassword();
      log('info', tag + ' type password');
      await adapter.type("input[type='password']", chromePassword + '\n');
      await sleep(3_000);
      snap = await adapter.snapshot();
      state = detect(snap);
      log('info', tag + ' after pw: ' + state + ' | ' + txt(snap));
    } else if (state === 'email_entry') {
      throw new Error('stuck at email: ' + txt(snap));
    }

    // ── Step 3: 验证码 ──
    if (state === 'email_verification' || state === 'code_entry') {
      log('info', tag + ' wait code...');
      const code = await cuicui.pollForCode(cred, MAIL_POLL_INT, MAIL_POLL_MAX);
      log('success', tag + ' code: ' + code);
      await adapter.type("input[type='number'],input[inputmode='numeric'],input[name='code']", code + '\n');
      await sleep(3_000);
      snap = await adapter.snapshot();
      state = detect(snap);
      log('info', tag + ' after code: ' + state + ' | ' + txt(snap));
    }

    // ── Step 4: About You ──
    if (state === 'about_you') {
      const id = generateIdentity();
      log('info', tag + ' name: ' + id.fullName);
      await adapter.setInputValue("input[name='name'],input[type='text']", id.fullName);
      await sleep(500);
      try { await adapter.clickButtonByText('Continue'); } catch { /* ok */ }
      await sleep(5_000);
      snap = await adapter.snapshot();
      state = detect(snap);
      log('info', tag + ' after about: ' + state + ' | ' + txt(snap));
    }

    // ── Step 5: OAuth token ──
    const oauth2 = new OAuthClient(miniCfg, null);
    const authUrl2 = oauth2.getAuthUrl();
    snap = await adapter.snapshot();
    state = detect(snap);
    log('info', tag + ' step5: ' + state + ' | ' + txt(snap));

    const unsubscribe = adapter.onRequestUrlMatch(
      (u) => u.hostname === 'localhost' && Number(u.port) === OAUTH_PORT && (u.searchParams.has('code') || u.searchParams.has('error')),
      (u) => { callbackUrl = u.toString(); },
    );

    try {
      if (state === 'chatgpt_home' || state === 'unknown') {
        await adapter.goto(authUrl2, { timeoutMs: 30_000, waitForCf: false });
        await sleep(3_000);
        snap = await adapter.snapshot();
        state = detect(snap);
        log('info', tag + ' auth: ' + state + ' | ' + txt(snap));
      }
      if (state === 'authorize') {
        const btn = snap.buttonLabels.find((b) => /authorize|allow|accept|continue/i.test(b) && b.length < 20);
        if (btn) { log('info', tag + ' click ' + btn); try { await adapter.clickButtonByText(btn); } catch { /* ok */ } }
      }
      for (let w = 0; w < 30 && !callbackUrl; w++) await sleep(2_000);
    } finally { unsubscribe(); }

    if (!callbackUrl) throw new Error('no OAuth callback');
    const params = oauth2.extractCallbackParams(callbackUrl);
    if (!params || !params.code) throw new Error('OAuth fail: ' + (params ? params.error : 'no code'));

    log('info', tag + ' exchange token...');
    const { token } = await oauth2.exchangeTokenAndSave(params.code, cred.email);

    const outPath = path.join(outDir, cred.email + '.json');
    fs.writeFileSync(outPath, JSON.stringify({
      type: 'codex', email: cred.email, account_id: token.account_id, plan_type: 'free',
      access_token: token.access_token, refresh_token: token.refresh_token,
      id_token: token.id_token, expired: token.expired, last_refresh: token.last_refresh,
      disabled: false, chatgpt_password: chromePassword,
    }, null, 2), 'utf8');
    log('success', tag + ' done -> ' + outPath);

    return { email: cred.email, status: 'success', outputPath: outPath, accountId: token.account_id, planType: 'free', durationMs: Date.now() - t0 };
  } catch (err) {
    const message = (err as Error).message || String(err);
    log('error', tag + ' fail: ' + message);
    return { email: cred.email, status: 'failed', error: message, durationMs: Date.now() - t0 };
  } finally {
    adapter.close().catch(() => {});
    setTimeout(() => { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ok */ } }, 10_000);
  }
}

/** 跑一批注册。返回批摘要并落盘 <out>/_summary.json。 */
export async function runBatchEmail(opts: BatchEmailOptions): Promise<BatchSummary> {
  const apiKey = opts.apiKey ?? process.env.OUTLOOK007_API_KEY;
  if (!apiKey) throw new Error('缺少 OUTLOOK007_API_KEY 环境变量（锤锤 outlook007 API key）');
  const outDir = opts.out ?? process.env.OUTLOOK007_OUT_DIR ?? path.join('output', new Date().toISOString().slice(0, 10));
  fs.mkdirSync(outDir, { recursive: true });
  const log = makeLogger(path.join(outDir, 'batch.log'));

  const max = opts.count ?? Infinity;
  const startIdx = (opts.start ?? 1) - 1;

  const all = parseCredentialFile(fs.readFileSync(opts.creds, 'utf8'));
  log('info', 'total ' + all.length + ' emails');
  const creds = all.slice(startIdx, startIdx + Math.min(max, all.length));
  log('info', 'batch ' + (startIdx + 1) + '-' + (startIdx + creds.length));

  const cuicui = new CuiCuiMailProvider({ apiKey, apiBaseUrl: API_BASE });
  const results: RegisterResult[] = [];
  const t0 = new Date().toISOString();

  for (let i = 0; i < creds.length; i++) {
    const cred = creds[i];
    if (!cred) continue;
    const gi = startIdx + i + 1;
    log('info', '\n' + '━'.repeat(50));
    log('info', '#' + gi + '/' + all.length + ': ' + cred.email);
    const r = await registerOne(cred, gi, all.length, cuicui, outDir, log);
    results.push(r);
    if (r.status === 'success' && i < creds.length - 1) { log('info', 'wait ' + ACCOUNT_DELAY_MS / 1000 + 's'); await sleep(ACCOUNT_DELAY_MS); }
    if (r.status === 'failed' && i < creds.length - 1) await sleep(5_000);
  }

  const ok = results.filter((r) => r.status === 'success').length;
  const ng = results.filter((r) => r.status === 'failed').length;
  const sum: BatchSummary = { startedAt: t0, finishedAt: new Date().toISOString(), total: creds.length, success: ok, failed: ng, skipped: 0, results };
  fs.writeFileSync(path.join(outDir, '_summary.json'), JSON.stringify(sum, null, 2), 'utf8');
  log('info', 'DONE: ' + ok + '/' + creds.length);
  for (const r of results.filter((r) => r.status === 'failed')) { log('info', '  - ' + r.email + ': ' + (r.error || '?')); }
  return sum;
}

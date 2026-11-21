/**
 * 验证码 —— SVG 数学算式（a+b），一次性使用，5 分钟过期，上限 500 条防内存涨。
 * 选算式而非扭曲字形：机器可解析（e2e 友好）、人类零负担；安全强度对个人台足够。
 */
import { randomUUID } from 'node:crypto';

interface Captcha {
  answer: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ALIVE = 500;

const g = globalThis as typeof globalThis & { __adminCaptchas?: Map<string, Captcha> };
const store = (g.__adminCaptchas ??= new Map());

function sweep() {
  const now = Date.now();
  for (const [id, c] of store) if (now > c.expiresAt) store.delete(id);
  while (store.size > MAX_ALIVE) store.delete(store.keys().next().value as string);
}

export function newCaptcha(): { captchaId: string; svg: string } {
  sweep();
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const id = randomUUID();
  store.set(id, { answer: String(a + b), expiresAt: Date.now() + TTL_MS });
  // 算式拆成多段错位文本 + 干扰点，肉眼易读、略防直链抓取
  const terms = [`${a}`, '+', `${b}`, '=', '?'];
  const spans = terms
    .map((t, i) => `<text x="${18 + i * 26 + Math.random() * 4}" y="${26 + Math.random() * 4}" font-size="20" font-family="monospace" fill="#1f2937" transform="rotate(${(Math.random() * 8 - 4).toFixed(1)} 30 26)">${t}</text>`)
    .join('');
  const dots = Array.from({ length: 6 }, () => `<circle cx="${Math.random() * 120}" cy="${Math.random() * 40}" r="1" fill="#94a3b8"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect width="120" height="40" fill="#f1f5f9"/>${dots}${spans}</svg>`;
  return { captchaId: id, svg };
}

/** 校验并销毁（一次性）。 */
export function verifyCaptcha(captchaId: string | undefined, code: string | undefined): boolean {
  if (!captchaId || !code?.trim()) return false;
  const c = store.get(captchaId);
  if (!c) return false;
  store.delete(captchaId);
  return Date.now() <= c.expiresAt && c.answer === code.trim();
}

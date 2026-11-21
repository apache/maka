// Mac 会话归档增补（2026-10-25）——archive_phase2.py 的 Node 适配
// 源：~/.claude/projects、~/.codex/sessions（含 .zst）、~/.cursor/projects/*/agent-transcripts
// 规范与 tools/archive_phase2.py 一致：frontmatter md + 用户提问/最终结论/工具摘要，
// 命名 md/<tool>/<slug(cwd)>/<YYYY-MM-DD>_<id8>.md；已存在的 id 跳过（幂等去重）。
// 不复制 raw、不删源；~/.zcode 不在本脚本范围。
// 用法: node archive_mac_2026-10-25.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const HOME = os.homedir();
const OUT = '/Users/ggbdpq/cc/guahub/sessions';
const MD = path.join(OUT, 'md');
const MANIFEST = path.join(OUT, 'manifest.jsonl');

// ---- 规范函数（复刻 archive_phase2.py）----
const fold = (t, n) => {
  if (t == null) return '';
  t = String(t).trim();
  return t.length <= n ? t : t.slice(0, n - 6) + '…（截断）';
};
const slug = (s, n = 80) => {
  s = String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, n) || 'unknown';
};
const NOISE_PREFIX = ['The TodoWrite tool hasn\'t been used recently', '<system-reminder>', 'system-reminder>', 'Caveat:', '<user_instructions>', '<environment_context>', '<turn_context>', '[Request interrupted', '<bash-input>', '<bash-stdout>', '<bash-stderr>', '<local-command', '<command-name>', '<command-message>', '<command-args>', 'API Error', 'This session is being continued'];
const RE_HARNESS = /^\[\d+\]\s+(tool|user|assistant|system)\b/;
const isNoise = (t) => {
  t = t.replace(/^\s+/, '');
  return NOISE_PREFIX.some(p => t.startsWith(p)) || RE_HARNESS.test(t);
};
const asDict = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const blocksText = (content, want) => {
  const out = [];
  if (typeof content === 'string') { if (want.has('text')) out.push(content); return out; }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object') { if (want.has(b.type) && b.text) out.push(b.text); }
      else if (typeof b === 'string' && want.has('text') && b.trim()) out.push(b);
    }
  }
  return out;
};
// 脱敏（inventory 2026-10-20 的口径：sk-/gh?_/AKIA/Bearer/password=/私钥/glm-长串；短模型名保留）
const REDACTIONS = [
  [/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/gh[A-Za-z0-9]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._-]{15,}/g, 'Bearer [REDACTED]'],
  [/password[=:]\S+/gi, 'password=[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]'],
  [/\bglm[s]?[-_][A-Za-z0-9.-]{20,}\b/g, '[REDACTED]'],
];
const redact = (t) => REDACTIONS.reduce((s, [re, to]) => s.replace(re, to), String(t ?? ''));

const newRec = (tool, sid) => ({ id: sid, tool, cwd: '', model: '', start: null, end: null, turns: 0, tokensIn: 0, tokensOut: 0, prompts: [], finals: [], tools: new Map() });
const bumpTool = (rec, name) => rec.tools.set(name, (rec.tools.get(name) || 0) + 1);
const CODEX_SKIP_PREFIX = ['<user_instructions>', '<environment_context>', '<turn_context>', '# AGENTS', '<permissions'];
const CURSOR_Q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/g;

// ---- 解析器 ----
function parseClaude(lines, fallbackId) {
  let rec = null;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain) continue;
    const t = o.type;
    if (t !== 'user' && t !== 'assistant') continue;
    if (!rec) { rec = newRec('claude', o.sessionId || fallbackId); rec.cwd = o.cwd || ''; }
    if (o.timestamp) { rec.start = rec.start || o.timestamp; rec.end = o.timestamp; }
    const msg = asDict(o.message);
    const content = msg.content;
    if (t === 'user') {
      for (const x of blocksText(content, new Set(['text']))) {
        if (x.trim() && !isNoise(x)) { rec.prompts.push(redact(x)); rec.turns++; }
      }
    } else {
      rec.model = rec.model || msg.model || '';
      for (const x of blocksText(content, new Set(['text']))) if (x.trim()) rec.finals.push(redact(x));
      if (Array.isArray(content)) for (const b of content) if (b && b.type === 'tool_use') bumpTool(rec, b.name || '?');
      const u = asDict(msg.usage);
      rec.tokensIn += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      rec.tokensOut += u.output_tokens || 0;
    }
  }
  return rec;
}

function parseCodex(lines, fallbackId) {
  let rec = null;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const ty = o.type, ts = o.timestamp;
    if (ty === 'session_meta') {
      const pay = asDict(o.payload);
      if (!rec) {
        rec = newRec('codex', pay.id || pay.session_id || fallbackId);
        rec.cwd = pay.cwd || '';
        if (ts) rec.start = rec.start || ts;
      }
      continue;
    }
    if (!rec) rec = newRec('codex', fallbackId);
    if (ts) { rec.start = rec.start || ts; rec.end = ts; }
    if (ty === 'turn_context') { rec.model = rec.model || asDict(o.payload).model || ''; continue; }
    if (ty !== 'response_item') continue;
    const pay = asDict(o.payload);
    const pt = pay.type;
    if (pt === 'message') {
      const role = pay.role;
      const texts = [];
      for (const b of pay.content || []) if (b && typeof b === 'object' && b.text) texts.push(b.text);
      for (const x of texts) {
        if (role === 'user' && !CODEX_SKIP_PREFIX.some(p => x.startsWith(p)) && !isNoise(x)) {
          rec.prompts.push(redact(x.replace(/^\s*user:\s+/, ''))); rec.turns++;
        } else if (role === 'assistant') rec.finals.push(redact(x));
      }
    } else if (['function_call', 'local_shell_call', 'custom_tool_call', 'web_search_call'].includes(pt)) {
      bumpTool(rec, pay.name || pt);
    } else if (pt === 'event_msg' && pay.type === 'token_count') {
      const info = asDict(pay.info || pay);
      const tu = asDict(info.total_token_usage || info);
      rec.tokensIn += parseInt(tu.input_tokens || tu.input || 0) || 0;
      rec.tokensOut += parseInt(tu.output_tokens || tu.output || 0) || 0;
    }
  }
  return rec;
}

function parseCursor(lines, id, mtimeIso) {
  const rec = newRec('cursor', id);
  rec.start = rec.end = mtimeIso;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const role = o.role;
    const content = asDict(o.message).content;
    if (role === 'user') {
      for (const x of blocksText(content, new Set(['text']))) {
        let hit = false;
        for (const m of x.matchAll(CURSOR_Q)) {
          if (m[1].trim() && !isNoise(m[1])) { rec.prompts.push(redact(m[1])); rec.turns++; }
          hit = true;
        }
        if (!hit && !x.includes('<user_query>') && x.trim() && !isNoise(x)) { rec.prompts.push(redact(x)); rec.turns++; }
      }
    } else if (role === 'assistant') {
      for (const x of blocksText(content, new Set(['text']))) if (x.trim()) rec.finals.push(redact(x));
      if (Array.isArray(content)) for (const b of content) if (b && b.type === 'tool_use') bumpTool(rec, b.name || '?');
    }
  }
  return rec;
}

// ---- write_md（复刻格式）----
function writeMd(rec, src) {
  if (!rec.prompts.length && !rec.finals.length) return null;
  const proj = slug(rec.cwd || 'unknown');
  let date = (rec.start || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) date = 'unknown-date';
  const rel = path.join('md', rec.tool, proj, `${date}_${String(rec.id).slice(0, 8)}.md`);
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const L = ['---',
    `tool: ${rec.tool}`,
    `project: ${proj}`,
    `cwd: ${rec.cwd || ''}`,
    `model: ${fold(rec.model, 80) || 'unknown'}`,
    `start: ${rec.start || '-'}`,
    `end: ${rec.end || '-'}`,
    `turns: ${rec.turns}`,
    `tokens_in: ${rec.tokensIn}`,
    `tokens_out: ${rec.tokensOut}`,
    `indexed_by_magpie: -`,
    `source: ${src}`,
    '---', ''];
  L.push(`# ${fold(rec.prompts[0] ?? rec.id, 100)}`, '');
  L.push(`## 用户提问（${rec.prompts.length} 条）`, '');
  const show = rec.prompts.slice(0, 50);
  show.forEach((p, i) => { L.push(`### Q${i + 1}`); L.push(fold(p, 1500)); L.push(''); });
  if (rec.prompts.length > 50) L.push(`（其余 ${rec.prompts.length - 50} 条见 raw 原始文件）`, '');
  L.push('## 助手最终结论', '');
  const finals = rec.finals.filter(x => x.length >= 30).slice(-3);
  if (!finals.length) L.push('（无实质文本结论）', '');
  finals.forEach((x, i) => { L.push(`### A${i + 1}`); L.push(fold(x, 2000)); L.push(''); });
  if (rec.tools.size) {
    const top = [...rec.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join('，');
    L.push('## 工具调用摘要', '', top, '');
  }
  fs.writeFileSync(abs, L.join('\n'), 'utf8');
  return rel;
}

// ---- 已归档 id 收集（幂等去重：同工具下 id8 已存在即跳过）----
const seenByTool = new Map();
for (const tool of fs.readdirSync(MD)) {
  const set = new Set();
  const toolDir = path.join(MD, tool);
  if (!fs.statSync(toolDir).isDirectory()) continue;
  for (const proj of fs.readdirSync(toolDir)) {
    const pd = path.join(toolDir, proj);
    try { if (!fs.statSync(pd).isDirectory()) continue; } catch { continue; }
    for (const f of fs.readdirSync(pd)) { const m = f.match(/^\d{4}-\d{2}-\d{2}_(.+)\.md$/); if (m) set.add(m[1]); }
  }
  seenByTool.set(tool, set);
}
const seenCount = Object.fromEntries([...seenByTool].map(([t, s]) => [t, s.size]));
console.log('已归档 id 基线:', JSON.stringify(seenCount));

// ---- 扫描源 ----
const walk = (dir, pred, acc = []) => {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
};
const claudeFiles = walk(path.join(HOME, '.claude', 'projects'), p => p.endsWith('.jsonl'));
const codexFiles = walk(path.join(HOME, '.codex', 'sessions'), p => p.endsWith('.jsonl') || p.endsWith('.jsonl.zst'));
const cursorFiles = walk(path.join(HOME, '.cursor', 'projects'), p => p.includes('agent-transcripts') && p.endsWith('.jsonl'));
console.log(`源文件: claude=${claudeFiles.length} codex=${codexFiles.length} cursor=${cursorFiles.length}`);

const readText = (p) => p.endsWith('.zst') ? zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- 主流程 ----
const stats = { claude: { md: 0, skipDup: 0, empty: 0 }, codex: { md: 0, skipDup: 0, empty: 0 }, cursor: { md: 0, skipDup: 0, empty: 0 } };
const projCount = {};
const manifestStream = fs.createWriteStream(MANIFEST, { flags: 'a' });
const handle = (file, tool, parse) => {
  const st = fs.statSync(file);
  let rec;
  try { rec = parse(readText(file).split('\n'), path.parse(file).name.replace(/\.jsonl$/, '')); }
  catch (e) { console.log(`PARSE FAIL ${file}: ${e.message}`); return; }
  if (!rec) { stats[tool].empty++; return; }
  const id8 = String(rec.id).slice(0, 8);
  const seen = seenByTool.get(tool);
  if (seen && seen.has(id8)) { stats[tool].skipDup++; return; }
  seen && seen.add(id8);
  const rel = writeMd(rec, file);
  if (!rel) { stats[tool].empty++; return; }
  stats[tool].md++;
  const proj = slug(rec.cwd || 'unknown');
  projCount[`${tool}/${proj}`] = (projCount[`${tool}/${proj}`] || 0) + 1;
  manifestStream.write(JSON.stringify({
    source: file, sha256: sha256(file), size: st.size,
    mtime: st.mtime.toISOString(), tool,
    archive: '-', md: rel, magpie: '-', status: 'ok',
  }) + '\n');
};

for (const f of claudeFiles) handle(f, 'claude', (lines, id) => parseClaude(lines, id));
for (const f of codexFiles) handle(f, 'codex', (lines, id) => { const r = parseCodex(lines, id); return r; });
for (const f of cursorFiles) {
  const uuid = path.basename(path.dirname(f));
  const projDir = path.basename(path.dirname(path.dirname(path.dirname(f)))); // projects/<proj>/agent-transcripts/<uuid>/x.jsonl
  const st = fs.statSync(f);
  const mtimeIso = st.mtime.toISOString().slice(0, 19).replace('T', 'T'); // 保持 ISO 形式
  handle(f, 'cursor', (lines) => { const r = parseCursor(lines, uuid, st.mtime.toISOString().slice(0, 19)); r.cwd = projDir; return r; });
}
manifestStream.end();
fs.writeFileSync('/tmp/mac-archive-stats.json', JSON.stringify({ stats, projCount }, null, 2));
console.log('完成:', JSON.stringify(stats));
console.log('项目分布:', JSON.stringify(projCount));

// 固定六个项目级 Go Skills；复装保护本地改动，不提供全局或批量更新入口。
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = 'samber/cc-skills-golang';
const ref = '8e899e20ff0cd4dc524af3993e4c62d8ee8c5717';
const cli = 'skills@1.7.1';
const names = ['golang-code-style', 'golang-error-handling', 'golang-testing', 'golang-concurrency', 'golang-context', 'golang-lint'];
const command = process.argv[2] ?? 'check';
const present = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

function hashFolder(base) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      requireCondition(!entry.isSymbolicLink(), `Skill 内不允许链接：${path}`);
      if (entry.isDirectory()) walk(path);
      else {
        requireCondition(entry.isFile() && (lstatSync(path).mode & 0o111) === 0, `Skill 内不允许可执行或特殊文件：${path}`);
        files.push({ path: relative(base, path).split('\\').join('/'), content: readFileSync(path) });
      }
    }
  }
  walk(base);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update(file.content);
  return hash.digest('hex');
}

function inspect(allowMissing) {
  const lockPath = join(root, 'web/docs/skills-lock.json');
  requireCondition(!present(lockPath) || !lstatSync(lockPath).isSymbolicLink(), '锁文件不可链接到其他作用域');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { version: 1, skills: {} };
  requireCondition(lock.version === 1 && lock.skills && typeof lock.skills === 'object' && !Array.isArray(lock.skills), '锁文件格式不兼容，停止以保护现有记录');
  // 防止父目录链接把项目级写入导向其他工作区或用户目录。
  for (const path of ['.agents', '.agents/skills', '.claude', '.claude/skills']) {
    const full = join(root, path);
    if (present(full)) requireCondition(lstatSync(full).isDirectory() && !lstatSync(full).isSymbolicLink(), `安装目录不可为链接或文件：${full}`);
  }
  const missing = [];
  for (const name of names) {
    const canonical = join(root, '.agents/skills', name);
    const link = join(root, '.claude/skills', name);
    const entry = lock.skills[name];
    if (entry) requireCondition(entry.source === source && entry.ref === ref && entry.sourceType === 'github' && entry.skillPath === `skills/${name}/SKILL.md` && /^[a-f0-9]{64}$/.test(entry.computedHash), `来源或版本冲突：${name}`);
    if (!present(canonical)) {
      requireCondition(allowMissing && !present(link), `缺失正文或残留链接：${name}`);
      missing.push(name);
      continue;
    }
    requireCondition(entry && lstatSync(canonical).isDirectory() && !lstatSync(canonical).isSymbolicLink(), `已有未锁定或非标准目录：${name}`);
    requireCondition(hashFolder(canonical) === entry.computedHash, `本地内容与锁文件不符，拒绝覆盖：${name}`);
    const skill = readFileSync(join(canonical, 'SKILL.md'), 'utf8');
    requireCondition(skill.startsWith('---\n') && skill.includes(`\nname: ${name}\n`) && /\ndescription:\s*\S/.test(skill), `Skill 入口元数据缺失：${name}`);
    requireCondition(present(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === `../../.agents/skills/${name}` && realpathSync(link) === realpathSync(canonical), `Claude 相对链接异常：${name}`);
  }
  return missing;
}

try {
  requireCondition(process.argv.length <= 3 && ['check', 'install'].includes(command), '用法：node web/scripts/go-skills.mjs [check|install]');
  const missing = inspect(command === 'install');
  if (missing.length) {
    const temporary = mkdtempSync(join(tmpdir(), 'guahub-go-skills-'));
    try {
      const result = spawnSync('npx', ['--yes', cli, 'add', `https://github.com/${source}/tree/${ref}`, '--skill', ...missing, '--agent', 'codex', 'claude-code', '--yes', '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DISABLE_TELEMETRY: '1', XDG_STATE_HOME: join(temporary, 'state'), npm_config_cache: join(temporary, 'npm'), npm_config_registry: 'https://registry.npmjs.org', npm_config_ignore_scripts: 'true' },
      });
      requireCondition(!result.error && result.status === 0, `官方 CLI 安装失败：${result.error?.message ?? result.stderr}`);
      const installed = JSON.parse(result.stdout);
      requireCondition(Array.isArray(installed) && installed.length === missing.length && installed.every(item => missing.includes(item.name) && item.status === 'installed' && item.scope === 'project'), '官方 CLI 未完整完成项目级安装');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    inspect(false);
  }
  console.log(`已完成：6 个 Go Skills 的来源、固定版本、内容摘要、入口与项目内相对链接检查${command === 'install' && !missing.length ? '；已安装，未写入' : ''}。`);
} catch (error) {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
}

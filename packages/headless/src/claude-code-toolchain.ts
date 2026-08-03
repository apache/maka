import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join } from 'node:path';

export const CLAUDE_CODE_TOOLCHAIN_CONTAINER_PATH = '/opt/maka-claude-code-toolchain';

export const CLAUDE_CODE_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  claudeCode: {
    version: '2.1.220',
    url: 'https://downloads.claude.ai/claude-code-releases/2.1.220/linux-x64/claude',
    sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
    size: 275_012_592,
  },
} as const;

export const CLAUDE_CODE_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(CLAUDE_CODE_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export interface PreparedClaudeCodeToolchain {
  path: string;
  fingerprint: typeof CLAUDE_CODE_TOOLCHAIN_FINGERPRINT;
}

export async function validatePreparedClaudeCodeToolchain(
  path: string,
): Promise<PreparedClaudeCodeToolchain> {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (manifest.fingerprint !== CLAUDE_CODE_TOOLCHAIN_FINGERPRINT) {
    throw new Error(`Claude Code toolchain fingerprint mismatch: ${String(manifest.fingerprint)}`);
  }
  if (JSON.stringify(manifest.spec) !== JSON.stringify(CLAUDE_CODE_TOOLCHAIN_SPEC)) {
    throw new Error('Claude Code toolchain spec does not match the pinned contract');
  }
  const binaryPath = join(path, 'bin', 'claude');
  const binary = await stat(binaryPath);
  if (binary.size !== CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.size) {
    throw new Error('Claude Code toolchain binary size mismatch');
  }
  if ((await sha256File(binaryPath)) !== CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.sha256) {
    throw new Error('Claude Code toolchain binary SHA-256 mismatch');
  }
  const expectedChecksums = `${CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.sha256}  bin/claude\n`;
  if ((await readFile(join(path, 'checksums.sha256'), 'utf8')) !== expectedChecksums) {
    throw new Error('Claude Code toolchain checksums.sha256 does not match its manifest');
  }
  return { path, fingerprint: CLAUDE_CODE_TOOLCHAIN_FINGERPRINT };
}

export async function prepareClaudeCodeToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedClaudeCodeToolchain> {
  try {
    return await validatePreparedClaudeCodeToolchain(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = await mkdtemp(join(dirname(path), `.${basename(path)}-`));
  try {
    await mkdir(join(temporaryPath, 'bin'));
    const response = await (options.fetchFn ?? fetch)(CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.url);
    if (!response.ok || !response.body) {
      throw new Error(
        `failed to download ${CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.url}: HTTP ${response.status}`,
      );
    }
    const binaryPath = join(temporaryPath, 'bin', 'claude');
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      createWriteStream(binaryPath),
    );
    if ((await stat(binaryPath)).size !== CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.size) {
      throw new Error('Claude Code binary size mismatch');
    }
    if ((await sha256File(binaryPath)) !== CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.sha256) {
      throw new Error('Claude Code binary checksum mismatch');
    }
    await chmod(binaryPath, 0o755);
    await writeFile(
      join(temporaryPath, 'manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fingerprint: CLAUDE_CODE_TOOLCHAIN_FINGERPRINT,
          spec: CLAUDE_CODE_TOOLCHAIN_SPEC,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(
      join(temporaryPath, 'checksums.sha256'),
      `${CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode.sha256}  bin/claude\n`,
      'utf8',
    );
    await validatePreparedClaudeCodeToolchain(temporaryPath);
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await validatePreparedClaudeCodeToolchain(path);
    }
    return { path, fingerprint: CLAUDE_CODE_TOOLCHAIN_FINGERPRINT };
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [profile, baseUrl, systemRoot, command, ...args] = process.argv.slice(2);
if (profile !== 'codex' && profile !== 'claude-code' && profile !== 'reasonix') {
  throw new Error('external subject profile is required');
}
if (!command) throw new Error('external subject command is required');
if (!baseUrl || !URL.canParse(baseUrl)) throw new Error('external subject base URL is required');
if (!systemRoot?.startsWith('/')) throw new Error('external subject system root is required');

let credentialPath: string | undefined;
let child: ChildProcess | undefined;
let stopped = false;
const stop = (signal: NodeJS.Signals) => {
  stopped = true;
  removeCredential();
  child?.kill(signal);
};
const terminate = () => stop('SIGTERM');
const interrupt = () => stop('SIGINT');
process.once('SIGTERM', terminate);
process.once('SIGINT', interrupt);

let exitCode = 130;
try {
  if (profile === 'codex') {
    process.env.OPENAI_BASE_URL = baseUrl;
    await writePolicy(
      join(systemRoot, 'etc/codex'),
      'requirements.toml',
      'allowed_web_search_modes = ["disabled"]\n',
    );
  } else if (profile === 'claude-code') {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    await writePolicy(
      join(systemRoot, 'etc/claude-code'),
      'managed-settings.json',
      '{"permissions":{"deny":["WebSearch","WebFetch"]}}\n',
    );
  } else {
    const key = process.env.OPENAI_API_KEY;
    const modelReference = args[args.indexOf('--model') + 1];
    const effort = args[args.indexOf('--effort') + 1];
    const [provider, model] = modelReference?.split('/') ?? [];
    if (!key || provider !== 'maka-proxy' || !model || !effort) {
      throw new Error('Reasonix provider settings are incomplete');
    }
    const home = join(systemRoot, 'tmp/maka-reasonix');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, 'config.toml'),
      `default_model = ${JSON.stringify(modelReference)}\n\n[[providers]]\nname = "maka-proxy"\nkind = "openai"\nbase_url = ${JSON.stringify(baseUrl)}\nmodels = [${JSON.stringify(model)}]\napi_key_env = "OPENAI_API_KEY"\neffort = ${JSON.stringify(effort)}\n\n[sandbox]\nbash = "off"\n`,
      { mode: 0o600 },
    );
    credentialPath = join(home, '.env');
    await writeFile(credentialPath, `OPENAI_API_KEY=${JSON.stringify(key)}\n`, { mode: 0o600 });
    process.env.REASONIX_HOME = home;
  }
  if (!stopped) {
    const running = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child = running;
    exitCode = await new Promise<number>((resolveExit, reject) => {
      running.once('error', reject);
      running.once('exit', (code) => resolveExit(code ?? 1));
    });
  }
} finally {
  process.removeListener('SIGTERM', terminate);
  process.removeListener('SIGINT', interrupt);
  removeCredential();
}
process.stdout.write(
  JSON.stringify({
    schemaVersion: 'maka.external_subject_result.v1',
    usage: null,
    costUsd: null,
    artifacts: [],
  }),
);
process.exitCode = exitCode;

async function writePolicy(directory: string, name: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), contents);
}

function removeCredential(): void {
  if (credentialPath) rmSync(credentialPath, { force: true });
}

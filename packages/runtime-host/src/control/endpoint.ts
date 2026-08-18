import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FALLBACK_ENDPOINT_ROOT = '/tmp';
const PORTABLE_UNIX_SOCKET_PATH_LIMIT = 100;
const ENDPOINT_SOCKET_NAME = 'h.sock';
const MKDTEMP_SUFFIX_LENGTH = 6;
const WINDOWS_PIPE_PATH_ENV = 'MAKA_RUNTIME_HOST_PIPE_PATH';
const WINDOWS_PIPE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$security = [System.Security.AccessControl.FileSecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, $rights, $allow))
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $allow))
$pipe = Get-Item -LiteralPath $env:${WINDOWS_PIPE_PATH_ENV}
$pipe.SetAccessControl($security)
`;

export interface RuntimeHostEndpointInput {
  rootId: string;
  hostEpoch: string;
}

export interface RuntimeHostEndpoint {
  path: string;
  prepareAfterListen(): Promise<void>;
  cleanup(): Promise<void>;
}

export class RuntimeHostEndpointError extends Error {
  constructor(
    readonly code: 'insecure_endpoint_directory' | 'endpoint_path_too_long',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostEndpointError';
  }
}

export async function prepareRuntimeHostEndpoint(
  input: RuntimeHostEndpointInput,
): Promise<RuntimeHostEndpoint> {
  assertValidRootId(input.rootId);
  if (process.platform === 'win32') {
    const path = `\\\\.\\pipe\\maka-runtime-host-${input.rootId.slice(0, 16)}-${input.hostEpoch}`;
    return {
      path,
      async prepareAfterListen() {
        await secureWindowsNamedPipe(path);
      },
      async cleanup() {},
    };
  }

  const rootPrefix = endpointRootPrefix(input.rootId);
  const prefix = endpointDirectoryPrefix(rootPrefix, process.pid);
  const root = resolveEndpointRoot(prefix);
  await removeDeadEndpointDirectories(root, rootPrefix);
  const directory = await mkdtemp(join(root, prefix));
  try {
    await ensurePrivateEndpointDirectory(directory);
    const path = join(directory, ENDPOINT_SOCKET_NAME);
    if (Buffer.byteLength(path, 'utf8') > PORTABLE_UNIX_SOCKET_PATH_LIMIT) {
      throw new RuntimeHostEndpointError(
        'endpoint_path_too_long',
        `Runtime Host endpoint path exceeds the portable Unix socket limit: ${path}`,
      );
    }
    return {
      path,
      async prepareAfterListen() {
        await chmod(path, 0o600);
        const endpointStat = await lstat(path);
        if (
          !endpointStat.isSocket() ||
          endpointStat.uid !== currentUid() ||
          (endpointStat.mode & 0o077) !== 0
        ) {
          throw new RuntimeHostEndpointError(
            'insecure_endpoint_directory',
            `Runtime Host endpoint is not a private current-user socket: ${path}`,
          );
        }
      },
      async cleanup() {
        await unlink(path).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
        await rmdir(directory).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function secureWindowsNamedPipe(path: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    return Promise.reject(
      new RuntimeHostEndpointError(
        'insecure_endpoint_directory',
        'Runtime Host cannot locate Windows PowerShell to secure its Local IPC endpoint',
      ),
    );
  }
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PIPE_ACL_SCRIPT],
      {
        env: { ...process.env, [WINDOWS_PIPE_PATH_ENV]: path },
        timeout: 10_000,
        windowsHide: true,
      },
      (error) => {
        if (!error) {
          resolve();
          return;
        }
        reject(
          new RuntimeHostEndpointError(
            'insecure_endpoint_directory',
            'Runtime Host could not restrict its Windows Local IPC endpoint to the current user',
          ),
        );
      },
    );
  });
}

// Honor TMPDIR via os.tmpdir(), but never at the cost of a socket path over
// the portable sun_path budget: macOS per-user temp roots and the parallel
// test runner's nested TMPDIR produce bases long enough that the full
// endpoint path would exceed 100 bytes, which is why the root used to be
// hardcoded to /tmp (#2133). If the worst-case path does not fit, fall back
// to /tmp; the post-mkdtemp length check stays as the backstop.
function resolveEndpointRoot(prefix: string): string {
  const candidate = tmpdir();
  const worstCasePath = join(
    candidate,
    `${prefix}${'X'.repeat(MKDTEMP_SUFFIX_LENGTH)}`,
    ENDPOINT_SOCKET_NAME,
  );
  if (Buffer.byteLength(worstCasePath, 'utf8') <= PORTABLE_UNIX_SOCKET_PATH_LIMIT) return candidate;
  return FALLBACK_ENDPOINT_ROOT;
}

function endpointRootPrefix(rootId: string): string {
  return `m-${currentUid()}-${endpointRootTag(rootId).slice(0, 16)}-`;
}

// Put the owner in the name passed to mkdtemp. A complete, parseable owner
// identity therefore appears atomically with the directory; a separate pid
// file would leave a creation-to-write window where another startup sweep
// could mistake a live directory for an abandoned one.
function endpointDirectoryPrefix(rootPrefix: string, pid: number): string {
  return `${rootPrefix}${pid.toString(36)}-`;
}

function endpointRootTag(rootId: string): string {
  return Buffer.from(rootId, 'hex').toString('base64url');
}

function assertValidRootId(rootId: string): void {
  if (!/^[a-f0-9]{64}$/.test(rootId)) {
    throw new RuntimeHostEndpointError(
      'insecure_endpoint_directory',
      'Runtime Host endpoint requires a valid storage root identity',
    );
  }
}

// Reclaims same-rootId endpoint directories whose owning process is gone,
// and only those: a concurrent live host keeps its directory (#2133). Both
// the resolved root and /tmp are swept because the fallback means either
// may hold leftovers. Pre-#2133 names have no owner identity, so they are
// deliberately left alone rather than guessed dead.
async function removeDeadEndpointDirectories(root: string, rootPrefix: string): Promise<void> {
  const roots = root === FALLBACK_ENDPOINT_ROOT ? [root] : [root, FALLBACK_ENDPOINT_ROOT];
  const ownedName = new RegExp(
    `^${escapeRegExp(rootPrefix)}([0-9a-z]+)-[A-Za-z0-9]{${MKDTEMP_SUFFIX_LENGTH}}$`,
  );
  await Promise.all(
    roots.map(async (endpointRoot) => {
      const entries = await readdir(endpointRoot, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory()) return;
          const match = ownedName.exec(entry.name);
          if (!match) return;
          const path = join(endpointRoot, entry.name);
          const directoryStat = await lstat(path).catch(() => undefined);
          if (!directoryStat?.isDirectory() || directoryStat.uid !== currentUid()) return;
          const pid = Number.parseInt(match[1] ?? '', 36);
          if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) return;
          await rm(path, { recursive: true, force: true });
        }),
      );
    }),
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone we cannot signal:
    // treat as alive so the sweep stays conservative.
    return isNodeError(error, 'EPERM');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ensurePrivateEndpointDirectory(path: string): Promise<void> {
  await chmod(path, 0o700);
  const directoryStat = await lstat(path);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== currentUid() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new RuntimeHostEndpointError(
      'insecure_endpoint_directory',
      `Runtime Host endpoint parent is not a private current-user directory: ${path}`,
    );
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new RuntimeHostEndpointError(
      'insecure_endpoint_directory',
      'Runtime Host POSIX endpoints require a current-user identity',
    );
  }
  return process.getuid();
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

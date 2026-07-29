/**
 * Tests for the pure permission evaluator.
 *
 * Run: `bun test packages/core/src/__tests__/permission.test.ts`
 */

import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  preToolUse,
  categorizeBash,
  permissionScopeKey,
  PERMISSION_POLICY,
  type PermissionMode,
  type ToolCategory,
  type ToolExecutionFacts,
} from '../permission.js';

const LOCAL_EXECUTION_FACTS: ToolExecutionFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

function evaluate(
  toolName: string,
  args: unknown,
  mode: PermissionMode,
  remembered: string[] = [],
  categoryHint?: ToolCategory,
) {
  return preToolUse({
    toolName,
    args,
    mode,
    turnRemembered: new Set(remembered),
    ...(categoryHint !== undefined ? { categoryHint } : {}),
  });
}

describe('sandbox-aware execute policy', () => {
  test('auto-allows shell_unsafe only when platform sandbox enforcement is available', () => {
    const common = {
      toolName: 'Bash',
      args: { command: 'npm install lodash' },
      mode: 'execute' as const,
      turnRemembered: new Set<string>(),
    };

    expect(
      preToolUse({
        ...common,
        sandbox: { platformSandboxAvailable: true },
      }).proceed,
    ).toBe(true);
    const unavailable = preToolUse({
      ...common,
      sandbox: { platformSandboxAvailable: false },
    });
    expect(unavailable.proceed).toBe(false);
    expect(unavailable.needsPrompt).toBe(true);
  });
});

describe('categorizeBash', () => {
  test('no shell command is auto-classified safe — categorizeBash never returns shell_safe', () => {
    // A shell command cannot be proven safe from its string: args can embed
    // execution (PowerShell `echo (Set-Content x)` runs Set-Content first;
    // $(...), backtick, iex do the same), and even "read-only" commands like
    // git status can trigger fsmonitor helpers. Read-only needs go through
    // typed tools (Read/Glob/Grep — fixed argv, no shell). So every shell
    // command is at least shell_unsafe → prompt, never auto-allowed.
    expect(categorizeBash('ls -la')).toBe('shell_unsafe');
    expect(categorizeBash('pwd')).toBe('shell_unsafe');
    expect(categorizeBash('grep -r foo .')).toBe('shell_unsafe');
    expect(categorizeBash('git status')).toBe('shell_unsafe');
    expect(categorizeBash('pandoc deck.pptx -t plain')).toBe('shell_unsafe');
    // The review's two P1 bypasses collapse into the same rule:
    expect(categorizeBash('echo (Set-Content .\\foo.txt hi)')).toBe('shell_unsafe');
    expect(categorizeBash('echo (New-Item .\\foo.txt)')).toBe('shell_unsafe');
    expect(categorizeBash('pandoc deck.pptx -o out.html')).toBe('shell_unsafe');
  });

  test('cd is NOT safe (excluded by design)', () => {
    expect(categorizeBash('cd /tmp')).toBe('shell_unsafe');
  });

  test('env is NOT safe (could leak secrets)', () => {
    expect(categorizeBash('env')).toBe('shell_unsafe');
    expect(categorizeBash('env | grep KEY')).toBe('shell_unsafe');
  });

  test('all rm forms → fs_destructive', () => {
    expect(categorizeBash('rm foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('rm -r dir')).toBe('fs_destructive');
    expect(categorizeBash('rm -rf /tmp/stuff')).toBe('fs_destructive');
    expect(categorizeBash('rm -fr /tmp/stuff')).toBe('fs_destructive');
    expect(categorizeBash('rm -Rf /tmp/stuff')).toBe('fs_destructive');
  });

  test('other fs_destructive commands', () => {
    expect(categorizeBash('rmdir empty')).toBe('fs_destructive');
    expect(categorizeBash('dd if=/dev/zero of=/dev/sda')).toBe('fs_destructive');
    expect(categorizeBash('shred -u secret.txt')).toBe('fs_destructive');
    expect(categorizeBash('truncate -s 0 log.txt')).toBe('fs_destructive');
    expect(categorizeBash('mkfs.ext4 /dev/sdb')).toBe('fs_destructive');
  });

  test('git restore / checkout -- → fs_destructive', () => {
    expect(categorizeBash('git restore .')).toBe('fs_destructive');
    expect(categorizeBash('git restore -- src/foo.ts')).toBe('fs_destructive');
    expect(categorizeBash('git checkout -- src/foo.ts')).toBe('fs_destructive');
  });

  test('find -delete / find -exec rm → fs_destructive', () => {
    expect(categorizeBash('find . -name "*.tmp" -delete')).toBe('fs_destructive');
    expect(categorizeBash('find /tmp -mtime +30 -exec rm {} \\;')).toBe('fs_destructive');
  });

  test('xargs rm/shred → fs_destructive', () => {
    expect(categorizeBash('xargs rm < files.txt')).toBe('fs_destructive');
    expect(categorizeBash('xargs -I {} shred {}')).toBe('fs_destructive');
  });

  test('PowerShell/cmd delete commands → fs_destructive (case-insensitive)', () => {
    expect(categorizeBash('Remove-Item .\\foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('remove-item -Recurse -Force .\\node_modules')).toBe('fs_destructive');
    expect(categorizeBash('del foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('erase foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('rd /s /q build')).toBe('fs_destructive');
    expect(categorizeBash('ri foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('Clear-Content log.txt')).toBe('fs_destructive');
    expect(categorizeBash('clc log.txt')).toBe('fs_destructive');
  });

  test('PowerShell pipeline into Remove-Item → fs_destructive', () => {
    expect(categorizeBash('Get-ChildItem -Recurse -Filter *.tmp | Remove-Item')).toBe(
      'fs_destructive',
    );
    expect(categorizeBash('Get-ChildItem . | del')).toBe('fs_destructive');
  });

  test('destructive command at ANY statement position → fs_destructive, both dialects', () => {
    // PowerShell shapes a model actually writes
    expect(categorizeBash('RM .\\foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('RMDIR .\\build')).toBe('fs_destructive');
    expect(categorizeBash('Get-ChildItem . | ForEach-Object { Remove-Item $_ }')).toBe(
      'fs_destructive',
    );
    expect(categorizeBash('Get-ChildItem . | ForEach-Object -Process { Remove-Item $_ }')).toBe(
      'fs_destructive',
    );
    expect(categorizeBash('gci *.tmp | % { ri $_ }')).toBe('fs_destructive');
    expect(categorizeBash('& Remove-Item foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('cd C:\\tmp; Remove-Item -Recurse build')).toBe('fs_destructive');
    // The same positional class on POSIX
    expect(categorizeBash('cd /tmp; rm -rf stuff')).toBe('fs_destructive');
    expect(categorizeBash('echo done && rm foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('echo $(rm foo.txt)')).toBe('fs_destructive');
  });

  test('git_destructive and privileged are also recognized at any statement position', () => {
    expect(categorizeBash('echo done && git push --force origin main')).toBe('git_destructive');
    expect(categorizeBash('echo hi; sudo reboot')).toBe('privileged');
  });

  test('quoted, escaped, or path-prefixed command names still categorize', () => {
    expect(categorizeBash("& 'Remove-Item' .\\foo.txt")).toBe('fs_destructive');
    expect(categorizeBash('& "ri" .\\foo.txt')).toBe('fs_destructive');
    expect(categorizeBash("& 'git' clean -fd")).toBe('git_destructive');
    expect(categorizeBash("& 'C:\\Program Files\\Git\\bin\\git.exe' clean -fd")).toBe(
      'git_destructive',
    );
    expect(categorizeBash('/bin/rm -rf /tmp/x')).toBe('fs_destructive');
    expect(categorizeBash('\\rm -rf /tmp/x')).toBe('fs_destructive');
    expect(categorizeBash('C:\\Windows\\System32\\taskkill.exe /IM node.exe')).toBe('privileged');
  });

  test('PowerShell/cmd process, service, and power commands → privileged', () => {
    expect(categorizeBash('Stop-Process -Name notepad')).toBe('privileged');
    expect(categorizeBash('spps -Name notepad')).toBe('privileged');
    expect(categorizeBash('taskkill /IM node.exe /F')).toBe('privileged');
    expect(categorizeBash('Get-Process notepad | Stop-Process')).toBe('privileged');
    expect(categorizeBash('Stop-Computer')).toBe('privileged');
    expect(categorizeBash('Restart-Computer -Force')).toBe('privileged');
    expect(categorizeBash('Stop-Service -Name w32time')).toBe('privileged');
  });

  test('wrapper commands do not hide the real command', () => {
    expect(categorizeBash('nohup rm -rf /tmp/x')).toBe('fs_destructive');
    expect(categorizeBash('timeout 30 rm foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('env FOO=bar rm foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('command rm foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('time make build')).toBe('shell_unsafe');
  });

  test('literal payloads of shell-in-shell commands are categorized recursively', () => {
    expect(categorizeBash('cmd /c del foo.txt')).toBe('fs_destructive');
    expect(categorizeBash("bash -c 'rm -rf /tmp/x'")).toBe('fs_destructive');
    expect(categorizeBash("bash -lc 'rm -rf /tmp/x'")).toBe('fs_destructive');
    expect(categorizeBash('pwsh -NoProfile -Command "Remove-Item x"')).toBe('fs_destructive');
    expect(categorizeBash("bash -c 'echo hi'")).toBe('shell_unsafe');
  });

  test('separators inside a quoted nested-shell payload do not hide the delete', () => {
    expect(categorizeBash('cmd /c "del foo.txt & echo done"')).toBe('fs_destructive');
    expect(categorizeBash("bash -lc 'rm -rf /tmp/x && echo done'")).toBe('fs_destructive');
    expect(categorizeBash('pwsh -Command "Remove-Item x; Write-Host done"')).toBe('fs_destructive');
  });

  test('Windows service control commands → privileged', () => {
    expect(categorizeBash('Remove-Service -Name foo')).toBe('privileged');
    expect(categorizeBash('New-Service -Name foo -BinaryPathName C:\\svc.exe')).toBe('privileged');
    expect(categorizeBash('Suspend-Service w32time')).toBe('privileged');
    expect(categorizeBash('sc.exe delete foo')).toBe('privileged');
    expect(categorizeBash('sc config foo start= disabled')).toBe('privileged');
    expect(categorizeBash('net stop foo')).toBe('privileged');
    // read-only service queries stay un-upgraded
    expect(categorizeBash('sc query foo')).toBe('shell_unsafe');
  });

  test('quote/backtick/caret interruptions inside the command name still categorize', () => {
    // All three PowerShell shapes verified to delete files on real pwsh.
    expect(categorizeBash("Remove''-Item .\\foo.txt")).toBe('fs_destructive');
    expect(categorizeBash('Remove`-Item .\\foo.txt')).toBe('fs_destructive');
    expect(categorizeBash('R`M .\\foo.txt')).toBe('fs_destructive');
    // cmd.exe's escape-char analogue of the same trick
    expect(categorizeBash('de^l foo.txt')).toBe('fs_destructive');
  });

  test('default aliases of privileged service cmdlets → privileged', () => {
    expect(categorizeBash('spsv w32time')).toBe('privileged');
    expect(categorizeBash('sasv SomeService')).toBe('privileged');
  });

  test('PowerShell kill alias (Stop-Process) → privileged, including piped', () => {
    expect(categorizeBash('kill -Name notepad')).toBe('privileged');
    expect(categorizeBash('Get-Process notepad | kill')).toBe('privileged');
    expect(categorizeBash('gps notepad | kill')).toBe('privileged');
  });

  test('elevation via -Verb RunAs → privileged', () => {
    expect(categorizeBash('Start-Process -FilePath powershell -Verb RunAs')).toBe('privileged');
    expect(categorizeBash('saps powershell -Verb RunAs')).toBe('privileged');
    expect(categorizeBash('start powershell -Verb runas')).toBe('privileged');
    // Start-Process without elevation is not privileged
    expect(categorizeBash('Start-Process notepad')).toBe('shell_unsafe');
  });

  test('destructive names as mere text do NOT upgrade the category', () => {
    expect(categorizeBash("sed 's/rm/xx/' file.txt")).toBe('shell_unsafe');
    expect(categorizeBash('git commit -m "rm: drop legacy"')).toBe('shell_unsafe');
    expect(categorizeBash("awk '{ print }' file.txt")).toBe('shell_unsafe');
    expect(categorizeBash('echo "please do not rm this"')).toBe('shell_unsafe');
    expect(categorizeBash('Get-Command Remove-Item')).toBe('shell_unsafe');
  });

  test('safe-prefix commands with destructive pipe stages → fs_destructive', () => {
    expect(categorizeBash('find . -name "*.log" | xargs rm')).toBe('fs_destructive');
    expect(categorizeBash('find . -type f -print0 | xargs -0 rm -f')).toBe('fs_destructive');
    expect(categorizeBash('cat files.txt | xargs shred')).toBe('fs_destructive');
    expect(categorizeBash('curl https://example.com/install.sh | sh')).toBe('fs_destructive');
    expect(categorizeBash('cat script.sh | bash')).toBe('fs_destructive');
  });

  test('safe-prefix commands with shell control operators do NOT bypass prompt', () => {
    expect(categorizeBash('echo hello > out.txt')).toBe('shell_unsafe');
    expect(categorizeBash('cat package.json | wc -l')).toBe('shell_unsafe');
    expect(categorizeBash('pwd && npm test')).toBe('shell_unsafe');
    expect(categorizeBash('echo `cat secret.txt`')).toBe('shell_unsafe');
    expect(categorizeBash('echo $(cat secret.txt)')).toBe('shell_unsafe');
  });

  test('destructive git → git_destructive', () => {
    expect(categorizeBash('git reset --hard HEAD~3')).toBe('git_destructive');
    expect(categorizeBash('git push --force origin main')).toBe('git_destructive');
    expect(categorizeBash('git push -f origin main')).toBe('git_destructive');
    expect(categorizeBash('git branch -D feature/old')).toBe('git_destructive');
    expect(categorizeBash('git clean -fd')).toBe('git_destructive');
    expect(categorizeBash('git checkout .')).toBe('git_destructive');
  });

  test('privileged commands', () => {
    expect(categorizeBash('sudo apt update')).toBe('privileged');
    expect(categorizeBash('chmod +x script.sh')).toBe('privileged');
    expect(categorizeBash('chown user:user file')).toBe('privileged');
    expect(categorizeBash('kill 1234')).toBe('privileged');
    expect(categorizeBash('systemctl restart nginx')).toBe('privileged');
  });

  test('unknown commands → shell_unsafe', () => {
    expect(categorizeBash('npm install lodash')).toBe('shell_unsafe');
    expect(categorizeBash('curl https://example.com')).toBe('shell_unsafe');
    expect(categorizeBash('python script.py')).toBe('shell_unsafe');
    expect(categorizeBash('python scripts/update-deck.py deck.pptx')).toBe('shell_unsafe');
    expect(categorizeBash('custom-tool close deck.pptx')).toBe('shell_unsafe');
  });

  test('precedence: privileged > fs_destructive > git_destructive > safe', () => {
    // sudo rm is privileged, not fs_destructive
    expect(categorizeBash('sudo rm -rf /')).toBe('privileged');
  });

  test('find is not a safe prefix: its action primaries execute/mutate, even quoted', () => {
    // A safe prefix must be read-only in ALL forms. find is not: its action
    // primaries run commands, delete, or write. Detecting them in the raw
    // string is defeated by shell quote removal (find . -de'lete' runs
    // -delete), so find is dropped from the allowlist entirely rather than
    // guarded — read-only traversal prompts too.
    expect(categorizeBash('find . -name "*.ts"')).toBe('shell_unsafe');
    expect(categorizeBash('find src -type f')).toBe('shell_unsafe');
    expect(categorizeBash('find . "-delete"')).toBe('shell_unsafe');
    expect(categorizeBash("find . -de'lete'")).toBe('shell_unsafe');
    expect(categorizeBash("find . -ex'ec' rm {} +")).toBe('shell_unsafe');
    expect(categorizeBash('find . -ex\\ec chmod 777 {} +')).toBe('shell_unsafe');
  });

  test('git diff/log/show/status are all shell_unsafe (no shell auto-safe)', () => {
    // --output=<file> writes and --ext-diff/--textconv run helpers; git status
    // can trigger fsmonitor. None can be proven safe from the string, and none
    // needs to be — read-only git goes through typed tools.
    expect(categorizeBash('git diff --output=src/foo.ts')).toBe('shell_unsafe');
    expect(categorizeBash('git log --output=notes.txt')).toBe('shell_unsafe');
    expect(categorizeBash('git show --output=patch.diff')).toBe('shell_unsafe');
    expect(categorizeBash('git diff')).toBe('shell_unsafe');
    expect(categorizeBash('git log --oneline -n 5')).toBe('shell_unsafe');
    expect(categorizeBash('git status')).toBe('shell_unsafe');
  });

  test('git branch is not a safe prefix (it can write a ref)', () => {
    expect(categorizeBash('git branch temp-review')).toBe('shell_unsafe');
    expect(categorizeBash('git branch -m old new')).toBe('shell_unsafe');
    expect(categorizeBash('git branch --list')).toBe('shell_unsafe');
  });
});

describe('preToolUse — explore mode', () => {
  test('Read tool → allow (read category)', () => {
    const r = evaluate('Read', { path: '/foo' }, 'explore');
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('read');
  });

  test('Write tool → block (file_write)', () => {
    const r = evaluate('Write', { path: '/foo', content: 'x' }, 'explore');
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('file_write');
    expect(r.blockReason).toContain('blocked');
  });

  test('read-only shell → block (no shell is auto-safe; use typed tools)', () => {
    const r = evaluate('Bash', { command: 'ls' }, 'explore');
    expect(r.proceed).toBe(false);
    expect(r.category).toBe('shell_unsafe');
  });

  test('unsafe bash → block', () => {
    const r = evaluate('Bash', { command: 'npm install x' }, 'explore');
    expect(r.proceed).toBe(false);
    expect(r.category).toBe('shell_unsafe');
  });

  test('rm → block (fs_destructive)', () => {
    const r = evaluate('Bash', { command: 'rm foo.txt' }, 'explore');
    expect(r.proceed).toBe(false);
    expect(r.category).toBe('fs_destructive');
  });

  test('trusted read-only subagent tool → allow', () => {
    const r = evaluate(
      'ExploreAgent',
      { objective: 'map the repo', queries: ['permission'] },
      'explore',
      [],
      'subagent',
    );
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('subagent');
  });
});

describe('preToolUse — ask mode', () => {
  test('Read tool → allow', () => {
    const r = evaluate('Read', {}, 'ask');
    expect(r.proceed).toBe(true);
  });

  test('Write tool → prompt', () => {
    const r = evaluate('Write', { path: '/x' }, 'ask');
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('file_write');
    expect(r.partialRequest).toBeDefined();
    expect(r.partialRequest?.reason).toBe('file_write');
  });

  test('read-only shell → prompt (no shell is auto-safe)', () => {
    const r = evaluate('Bash', { command: 'pwd' }, 'ask');
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('shell_unsafe');
  });

  test('rm → prompt', () => {
    const r = evaluate('Bash', { command: 'rm -rf x' }, 'ask');
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('fs_destructive');
    expect(r.partialRequest?.reason).toBe('fs_destructive');
  });
});

describe('preToolUse — execute mode', () => {
  test('Write tool → allow', () => {
    const r = evaluate('Write', { path: '/x', content: 'y' }, 'execute');
    expect(r.proceed).toBe(true);
    expect(r.category).toBe('file_write');
  });

  test('unknown bash → prompt (execute is fail-closed for unrecognized shell)', () => {
    // The security boundary no longer depends on the pattern list being
    // exhaustive: a command we cannot prove safe lands in shell_unsafe and
    // PROMPTS. Anything the blocklist misses (dialect/alias/escape variants)
    // now degrades to an extra confirmation, never a silent execution.
    const r = evaluate('Bash', { command: 'npm install lodash' }, 'execute');
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('shell_unsafe');
  });

  test('read-only shell prompts in execute too (no shell auto-runs; typed tools do)', () => {
    // git status is not provably safe (fsmonitor), so it prompts like any
    // other shell command. Read tool / Glob / Grep remain the auto-run path.
    for (const command of [
      'git status',
      'ls -la',
      'pandoc deck.pptx -o out.html',
      'echo (New-Item .\\foo.txt)',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
      expect(r.category).toBe('shell_unsafe');
    }
  });

  test('CRITICAL: rm STILL prompts in execute mode', () => {
    const r = evaluate('Bash', { command: 'rm important.txt' }, 'execute');
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('fs_destructive');
  });

  test('CRITICAL: Remove-Item STILL prompts in execute mode', () => {
    const r = evaluate('Bash', { command: 'Remove-Item .\\foo.txt' }, 'execute');
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('fs_destructive');
  });

  test('CRITICAL: find (incl. quoted actions) and git --output prompt in execute mode', () => {
    for (const command of [
      'find . -exec chmod 777 {} +',
      "find . -de'lete'",
      'find . -ex\\ec chmod 777 {} +',
      'find . -name "*.ts"',
      'git diff --output=src/foo.ts',
      'git log --output=notes.txt',
      'git branch temp-review',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
    }
  });

  test('CRITICAL: piped kill and RunAs elevation STILL prompt in execute mode', () => {
    for (const command of [
      'Get-Process notepad | kill',
      'gps notepad | kill',
      'Start-Process -FilePath powershell -Verb RunAs',
      'saps powershell -Verb RunAs',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
      expect(r.category).toBe('privileged');
    }
  });

  test('CRITICAL: interrupted names and service aliases STILL prompt in execute mode', () => {
    for (const command of [
      "Remove''-Item .\\foo.txt",
      'Remove`-Item .\\foo.txt',
      'R`M .\\foo.txt',
      'spsv w32time',
      'sasv SomeService',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
    }
  });

  test('CRITICAL: quoted nested payloads and service control STILL prompt in execute mode', () => {
    for (const command of [
      'cmd /c "del foo.txt & echo done"',
      "bash -lc 'rm -rf /tmp/x && echo done'",
      'pwsh -Command "Remove-Item x; Write-Host done"',
      'Remove-Service -Name foo',
      'sc.exe delete foo',
      'net stop foo',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
    }
  });

  test('CRITICAL: quoted names and PowerShell process kills STILL prompt in execute mode', () => {
    for (const command of [
      "& 'Remove-Item' .\\foo.txt",
      '& "ri" .\\foo.txt',
      "& 'git' clean -fd",
      'Stop-Process -Name notepad',
      'Get-Process notepad | Stop-Process',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
    }
  });

  test('CRITICAL: PowerShell deletes at any position STILL prompt in execute mode', () => {
    for (const command of [
      'RM .\\foo.txt',
      'RMDIR .\\build',
      'Get-ChildItem . | ForEach-Object { Remove-Item $_ }',
    ]) {
      const r = evaluate('Bash', { command }, 'execute');
      expect(r.proceed).toBe(false);
      expect(r.needsPrompt).toBe(true);
      expect(r.category).toBe('fs_destructive');
    }
  });

  test('CRITICAL: git reset --hard STILL prompts in execute mode', () => {
    const r = evaluate('Bash', { command: 'git reset --hard HEAD~5' }, 'execute');
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('git_destructive');
  });

  test('CRITICAL: sudo STILL prompts in execute mode', () => {
    const r = evaluate('Bash', { command: 'sudo systemctl stop foo' }, 'execute');
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('privileged');
  });

  test('execution facts are accepted without changing current policy decisions', () => {
    const input = {
      toolName: 'Bash',
      args: { command: 'npm install lodash' },
      mode: 'execute' as const,
      turnRemembered: new Set<string>(),
    };

    const baseline = preToolUse(input);
    const withFacts = preToolUse({
      ...input,
      executionFacts: LOCAL_EXECUTION_FACTS,
    });

    expect(withFacts).toEqual(baseline);
  });
});

describe('preToolUse — bypass mode', () => {
  test('rm → allow without prompting', () => {
    const r = evaluate('Bash', { command: 'rm important.txt' }, 'bypass');
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('fs_destructive');
  });

  test('git reset --hard → allow without prompting', () => {
    const r = evaluate('Bash', { command: 'git reset --hard HEAD~5' }, 'bypass');
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('git_destructive');
  });

  test('sudo → allow without prompting', () => {
    const r = evaluate('Bash', { command: 'sudo systemctl stop foo' }, 'bypass');
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('privileged');
  });

  test('browser actions → allow without prompting', () => {
    const r = evaluate('browser_click', { ref: '[12]' }, 'bypass', [], 'browser');
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
    expect(r.category).toBe('browser');
  });
});

describe('preToolUse — turnRemembered', () => {
  test('remembered scope → allow the same tool intent when policy says prompt', () => {
    const args = { path: '/x' };
    const r = evaluate('Write', args, 'ask', [permissionScopeKey('Write', args, 'file_write')]);
    expect(r.proceed).toBe(true);
    expect(r.needsPrompt).toBe(false);
  });

  test('remembered scope does not allow a different path in the same category', () => {
    const remembered = permissionScopeKey('Write', { path: '/x' }, 'file_write');
    const r = evaluate('Write', { path: '/y' }, 'ask', [remembered]);
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(true);
    expect(r.scopeKey === remembered).toBe(false);
  });

  test('WriteStdin never consumes turn memory even when its exact scope is present', () => {
    const args = {
      ref: 'maka://runtime/background-tasks/pty-1',
      input: 'y\r',
    };
    const remembered = permissionScopeKey('WriteStdin', args, 'shell_unsafe');
    const r = evaluate('WriteStdin', args, 'ask', [remembered]);

    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(true);
    expect(r.partialRequest?.rememberForTurnAllowed).toBe(false);
  });

  test('remembered does NOT override block', () => {
    const args = { path: '/x' };
    const r = evaluate('Write', args, 'explore', [permissionScopeKey('Write', args, 'file_write')]);
    expect(r.proceed).toBe(false);
    expect(r.needsPrompt).toBe(false);
    expect(r.blockReason).toContain('blocked');
  });

  test('scope key normalizes shell whitespace and sorts custom args', () => {
    expect(
      permissionScopeKey('Bash', { command: 'npm   test\n-- --runInBand' }, 'shell_unsafe'),
    ).toBe('shell_unsafe:Bash:npm test -- --runInBand');
    expect(permissionScopeKey('Custom', { b: 2, a: 1 }, 'custom_tool')).toBe(
      'custom_tool:Custom:{"a":1,"b":2}',
    );
  });
});

describe('preToolUse — browser permission contract', () => {
  test('a browser prompt carries the browser-specific reason (not custom)', () => {
    const r = evaluate('browser_click', { ref: '[12]' }, 'ask', [], 'browser');
    expect(r.needsPrompt).toBe(true);
    expect(r.category).toBe('browser');
    expect(r.partialRequest?.reason).toBe('browser');
  });

  test('browser scope is one turn-wide key, shared across every browser_* tool + args', () => {
    // The whole observe→act loop collapses to a single scope key — unlike
    // file_write above, which scopes per path.
    expect(permissionScopeKey('browser_click', { ref: '[12]' }, 'browser')).toBe('browser');
    expect(permissionScopeKey('browser_type', { ref: '[3]', text: 'hi' }, 'browser')).toBe(
      'browser',
    );
    expect(permissionScopeKey('browser_navigate', { url: 'https://x.com' }, 'browser')).toBe(
      'browser',
    );
  });

  test('"allow for this turn" on one browser action carries the rest of the loop', () => {
    const remembered = [
      permissionScopeKey('browser_navigate', { url: 'https://x.com' }, 'browser'),
    ];
    // A different browser tool, different args → allowed without re-prompting.
    const click = evaluate('browser_click', { ref: '[99]' }, 'execute', remembered, 'browser');
    expect(click.proceed).toBe(true);
    expect(click.needsPrompt).toBe(false);
    const type = evaluate('browser_type', { ref: '[2]', text: 'x' }, 'ask', remembered, 'browser');
    expect(type.proceed).toBe(true);
  });
});

describe('preToolUse — Computer Use permission contract', () => {
  test('Computer Use is blocked in explore and prompts in ask/execute', () => {
    for (const mode of ['ask', 'execute'] as const) {
      const result = evaluate(
        'maka_computer',
        { action: 'observe', app: 'Example' },
        mode,
        [],
        'computer_use',
      );
      expect(result.needsPrompt).toBe(true);
      expect(result.partialRequest?.reason).toBe('computer_use');
    }
    const explore = evaluate(
      'maka_computer',
      { action: 'observe', app: 'Example' },
      'explore',
      [],
      'computer_use',
    );
    expect(explore.proceed).toBe(false);
    expect(explore.needsPrompt).toBe(false);
  });

  test('permission events receive an allowlisted summary, not sensitive action args', () => {
    const result = evaluate(
      'maka_computer',
      {
        action: 'type',
        app: 'Example',
        window_id: 42,
        observation_id: 'frame-7',
        text: 'secret text',
        coordinate: [123, 456],
      },
      'execute',
      [],
      'computer_use',
    );
    expect(result.partialRequest?.args).toEqual({
      action: 'type',
      approvalClass: 'keyboard_mutation',
      rememberForTurnAllowed: true,
      app: 'Example',
      windowId: 42,
      observationId: 'frame-7',
    });
  });

  test('remembered metadata permission does not authorize screenshots or mutations', () => {
    const metadataArgs = {
      action: 'observe',
      include_screenshot: false,
      app: 'Example',
      window_id: 42,
    };
    const remembered = [permissionScopeKey('maka_computer', metadataArgs, 'computer_use')];
    const metadata = evaluate('maka_computer', metadataArgs, 'execute', remembered, 'computer_use');
    const screenshot = evaluate(
      'maka_computer',
      { ...metadataArgs, include_screenshot: true },
      'execute',
      remembered,
      'computer_use',
    );
    const click = evaluate(
      'maka_computer',
      {
        action: 'left_click',
        observation_id: 'frame-7',
        coordinate: [10, 20],
      },
      'execute',
      remembered,
      'computer_use',
    );

    expect(metadata.proceed).toBe(true);
    expect(screenshot.needsPrompt).toBe(true);
    expect(click.needsPrompt).toBe(true);
  });

  test('malformed Computer Use requests cannot use a forged remembered scope', () => {
    const args = {
      action: 'raw_unknown_action',
      app: 'Example',
    };
    const remembered = [permissionScopeKey('maka_computer', args, 'computer_use')];
    const result = evaluate('maka_computer', args, 'execute', remembered, 'computer_use');
    expect(result.needsPrompt).toBe(true);
    expect(result.proceed).toBe(false);
    expect(result.partialRequest?.rememberForTurnAllowed).toBe(false);
  });
});

describe('PERMISSION_POLICY matrix invariants', () => {
  const categories: ToolCategory[] = [
    'read',
    'web_read',
    'file_write',
    'fs_destructive',
    'shell_safe',
    'shell_unsafe',
    'git_destructive',
    'network_send',
    'privileged',
    'browser',
    'computer_use',
    'custom_tool',
    'subagent',
  ];
  const modes: PermissionMode[] = ['explore', 'ask', 'execute', 'bypass'];

  test('every (mode, category) pair has a decision', () => {
    for (const mode of modes) {
      for (const cat of categories) {
        expect(PERMISSION_POLICY[mode][cat]).toBeDefined();
      }
    }
  });

  test('execute mode never blocks fs_destructive — always prompts', () => {
    expect(PERMISSION_POLICY.execute.fs_destructive).toBe('prompt');
  });

  test('execute mode never blocks git_destructive — always prompts', () => {
    expect(PERMISSION_POLICY.execute.git_destructive).toBe('prompt');
  });

  test('execute mode never blocks privileged — always prompts', () => {
    expect(PERMISSION_POLICY.execute.privileged).toBe('prompt');
  });

  test('execute mode is fail-closed for shell: shell_unsafe AND shell_safe prompt', () => {
    // The root fix: no shell command is auto-allowed. shell_unsafe prompts,
    // and shell_safe (which categorizeBash no longer produces) is also fail-
    // closed so there is no auto-allow path left for shell at all.
    expect(PERMISSION_POLICY.execute.shell_unsafe).toBe('prompt');
    expect(PERMISSION_POLICY.execute.shell_safe).toBe('prompt');
  });

  test('browser is prompt-on-effect: blocked in explore, prompts in ask AND execute (never auto-allowed)', () => {
    expect(PERMISSION_POLICY.explore.browser).toBe('block');
    expect(PERMISSION_POLICY.ask.browser).toBe('prompt');
    // The key contrast with network_send: not silently allowed in execute.
    expect(PERMISSION_POLICY.execute.browser).toBe('prompt');
    expect(PERMISSION_POLICY.bypass.browser).toBe('allow');
  });

  test('computer_use is blocked in explore, prompts in ask/execute, and only bypass allows it', () => {
    expect(PERMISSION_POLICY.explore.computer_use).toBe('block');
    expect(PERMISSION_POLICY.ask.computer_use).toBe('prompt');
    expect(PERMISSION_POLICY.execute.computer_use).toBe('prompt');
    expect(PERMISSION_POLICY.bypass.computer_use).toBe('allow');
  });

  test('explore mode allows local reads but no shell (web_read prompts post PR-AGENT-WEB-SEARCH-TOOL-0)', () => {
    expect(PERMISSION_POLICY.explore.read).toBe('allow');
    // shell_safe is fail-closed like shell_unsafe: explore uses typed tools.
    expect(PERMISSION_POLICY.explore.shell_safe).toBe('block');
  });

  test('explore mode blocks all write/network/privileged', () => {
    expect(PERMISSION_POLICY.explore.file_write).toBe('block');
    expect(PERMISSION_POLICY.explore.fs_destructive).toBe('block');
    expect(PERMISSION_POLICY.explore.shell_unsafe).toBe('block');
    expect(PERMISSION_POLICY.explore.git_destructive).toBe('block');
    expect(PERMISSION_POLICY.explore.network_send).toBe('block');
    expect(PERMISSION_POLICY.explore.privileged).toBe('block');
    expect(PERMISSION_POLICY.explore.subagent).toBe('allow');
  });

  test('web_read prompts in non-autonomous modes (PR-AGENT-WEB-SEARCH-TOOL-0)', () => {
    // Agent-issued web requests are out-of-process side effects; the
    // user must confirm them even in `explore` mode. `execute` (yolo)
    // still allows so the user can opt into autonomous web search.
    expect(PERMISSION_POLICY.explore.web_read).toBe('prompt');
    expect(PERMISSION_POLICY.ask.web_read).toBe('prompt');
    expect(PERMISSION_POLICY.execute.web_read).toBe('allow');
    expect(PERMISSION_POLICY.bypass.web_read).toBe('allow');
  });

  test('bypass mode allows every category without prompting', () => {
    for (const cat of categories) {
      expect(PERMISSION_POLICY.bypass[cat]).toBe('allow');
    }
  });
});

import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const delaySeconds = Number.parseInt(process.env.MAKA_SHELL_WAKE_E2E_DELAY_SECONDS ?? '20', 10);
const configRoot = process.env.MAKA_SHELL_WAKE_E2E_CONFIG_ROOT;
const repoRoot = process.env.MAKA_SHELL_WAKE_E2E_REPO_ROOT;
if (!configRoot) throw new Error('MAKA_SHELL_WAKE_E2E_CONFIG_ROOT is required');
if (!repoRoot) throw new Error('MAKA_SHELL_WAKE_E2E_REPO_ROOT is required');
if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 120) {
  throw new Error('MAKA_SHELL_WAKE_E2E_DELAY_SECONDS must be between 1 and 120');
}
const { createMakaCliRuntimeContext } = await import(
  pathToFileURL(join(repoRoot, 'packages/cli/dist/runtime-bootstrap.js')).href
);

const stateRoot = await mkdtemp(join(tmpdir(), 'maka-shell-wake-state-'));
const taskCwd = await mkdtemp(join(tmpdir(), 'maka-shell-wake-task-'));
const invocations = [];
let context;

try {
  const taskPath = join(taskCwd, 'unknown-duration-task.sh');
  await writeFile(
    taskPath,
    `#!/bin/sh\nsleep ${delaySeconds}\nprintf '%s\\n' MAKA_WAKE_E2E_DONE\n`,
    'utf8',
  );
  await chmod(taskPath, 0o700);
  const startedAt = Date.now();
  let terminalAt;

  context = await createMakaCliRuntimeContext({
    surface: 'tui',
    workspaceRoot: stateRoot,
    stateRoot,
    configRoot,
    cwd: taskCwd,
    runtimeInvocationObserver: (result) => {
      invocations.push(result);
    },
  });

  const session = await context.runtime.createSession({
    cwd: taskCwd,
    name: 'Background shell completion wake E2E',
    backend: 'ai-sdk',
    llmConnectionSlug: context.target.connection.slug,
    model: context.target.model,
    permissionMode: 'bypass',
  });

  const shellUpdates = [];
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const unsubscribe = context.subscribeShellRunUpdates((update) => {
    if (update.sessionId !== session.id) return;
    shellUpdates.push(update);
    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(update.result.status)) {
      terminalAt = Date.now();
      resolveTerminal(update);
    }
  });

  const prompt = [
    'Run the unknown-duration task ./unknown-duration-task.sh and wait for its terminal result.',
    'Do not inspect the script; its duration is intentionally unknown to you.',
    'Use Bash with run_in_background=true.',
    'Do not finish before the background task completes.',
    'Choose how to wait based only on the tools available to you.',
    'After observing terminal completion, reply exactly MAKA_WAKE_E2E_DONE.',
  ].join('\n');

  const firstTurnEvents = [];
  for await (const event of context.runtime.sendMessage(session.id, {
    turnId: randomUUID(),
    text: prompt,
  })) {
    firstTurnEvents.push(event);
  }

  await withTimeout(terminal, (delaySeconds + 30) * 1_000, 'background process terminal event');
  let finalWaitError;
  try {
    await withTimeout(
      waitUntil(() => invocations.some((item) => item.finalOutput?.includes('MAKA_WAKE_E2E_DONE'))),
      30_000,
      'model final answer after background completion',
    );
  } catch (error) {
    finalWaitError = error instanceof Error ? error.message : String(error);
  }
  const finishedAt = Date.now();
  unsubscribe();

  const allEvents = invocations.flatMap((invocation) => invocation.events);
  const toolCalls = allEvents
    .filter((event) => event.content?.kind === 'function_call')
    .map((event) => ({ toolName: event.content.name, args: event.content.args }));
  const streamedToolCalls = firstTurnEvents
    .filter((event) => event.type === 'tool_start')
    .map((event) => ({ toolName: event.toolName, args: event.args }));
  const usage = allEvents
    .map((event) => event.actions?.tokenUsage)
    .filter(Boolean)
    .reduce(
      (sum, item) => ({
        input: sum.input + item.input,
        output: sum.output + item.output,
        total: sum.total + (item.total ?? item.input + item.output),
        runtimeSteps: sum.runtimeSteps + (item.runtimeSteps ?? 0),
      }),
      { input: 0, output: 0, total: 0, runtimeSteps: 0 },
    );

  process.stdout.write(
    `${JSON.stringify(
      {
        delaySeconds,
        repoRoot,
        model: context.target.model,
        connection: context.target.connection.slug,
        wallMs: finishedAt - startedAt,
        processTerminalMs: terminalAt === undefined ? null : terminalAt - startedAt,
        invocationCount: invocations.length,
        invocationDurationsMs: invocations.map((item) => item.finishedAt - item.startedAt),
        finalOutputs: invocations.map((item) => item.finalOutput ?? null),
        finalWaitError: finalWaitError ?? null,
        firstTurnEventCounts: countBy(firstTurnEvents, (event) => event.type),
        toolCalls,
        streamedToolCalls,
        invocationEventCounts: invocations.map((item) =>
          countBy(
            item.events,
            (event) => event.content?.kind ?? (event.actions?.tokenUsage ? 'usage' : 'control'),
          ),
        ),
        shellUpdates: shellUpdates.map((update) => ({
          status: update.result.status,
          notifyOnComplete: update.result.notifyOnComplete ?? false,
        })),
        usage,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await context?.close();
  await Promise.all([
    rm(stateRoot, { recursive: true, force: true }),
    rm(taskCwd, { recursive: true, force: true }),
  ]);
}

async function waitUntil(predicate) {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 25));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

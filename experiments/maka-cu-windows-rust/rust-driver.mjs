// Small protocol driver for the same WinForms fixture used by
// experiments/maka-cu-windows. It intentionally checks behavior, not only
// malformed JSON or token duplication.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [exe, hwndText] = process.argv.slice(2);
if (!exe || !hwndText) {
  console.error('usage: node rust-driver.mjs <helper.exe> <fixture-hwnd>');
  process.exit(2);
}
const hwnd = Number(hwndText);
if (!Number.isInteger(hwnd) || hwnd <= 0) throw new Error('invalid HWND');

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
const waiters = new Map();
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = waiters.get(message.id);
  if (waiter) { waiters.delete(message.id); waiter(message); }
});

let nextId = 1;
function call(method, params = {}) {
  const id = nextId++;
  const response = new Promise((resolve) => waiters.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return response;
}
function send(id, method, params = {}) {
  const response = new Promise((resolve) => waiters.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return response;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

try {
  const init = await call('initialize');
  assert(init.result?.protocol === 'maka.cu.windows/0', 'handshake protocol');
  const helperGeneration = init.result?.generation;
  assert(typeof helperGeneration === 'string' && helperGeneration.length > 0, 'helper generation is unique');
  assert(init.result?.capabilities?.capture?.targetWindowWgc === true, 'WGC capability advertised');

  const listed = await call('list_windows');
  assert(listed.result?.windows?.some((item) => item.hwnd === hwnd), 'explicit fixture HWND enumerated');
  const observed = await call('observe', { hwnd, maxNodes: 512 });
  assert(observed.result?.windowGeneration, 'UIA observe has target generation');
  const elements = observed.result.elements ?? [];
  assert(elements.length > 0, 'UIA observe returned elements');

  const capture = await call('capture', {
    hwnd,
    windowGeneration: observed.result.windowGeneration,
  });
  assert(capture.result?.status === 'available' || capture.result?.reason?.startsWith('capture_unavailable'), 'capture is WGC or typed unavailable');
  if (capture.result?.status === 'available') {
    assert(capture.result.path === 'wgc_createforwindow', 'capture path is CreateForWindow WGC');
    assert(capture.result.frame?.format === 'png' && capture.result.frame?.bytes <= 3 * 1024 * 1024, 'capture is bounded PNG');
  }

  const target = elements.find((item) => item.actions?.includes('set_value')) ?? elements.find((item) => item.actions?.includes('click_element'));
  assert(target, 'fixture exposes semantic action');
  const staleAction = {
    snapshotId: observed.result.snapshotId,
    elementToken: target.token,
    action: target.actions.includes('set_value') ? 'set_value' : 'click_element',
  };
  const action = target.actions.includes('set_value') ? 'set_value' : 'click_element';
  const acted = await call('act', {
    snapshotId: observed.result.snapshotId,
    elementToken: target.token,
    action,
    value: action === 'set_value' ? 'rust-driver-check' : undefined,
  });
  assert(acted.result?.outcome?.snapshotSpent === true, 'semantic action spends snapshot');
  assert(acted.result?.outcome?.status === 'verified' || acted.result?.outcome?.status === 'unknown', 'semantic action returns verification status');
  const duplicate = await call('act', { snapshotId: observed.result.snapshotId, elementToken: target.token, action });
  assert(duplicate.error?.message === 'snapshot_spent_or_unknown', 'duplicate action is refused');

  const sleeping = send(80, 'debug_sleep', { ms: 200 });
  const cancellation = await send(81, '$/cancel', { id: 80 });
  assert(cancellation.result?.cancelled === true, 'control plane accepts cancellation while worker runs');
  const settled = await sleeping;
  assert(settled.result?.sleptMs === 200, 'original cancelled request settles');

  const shutdown = await call('shutdown');
  assert(shutdown.result?.ok === true && shutdown.result?.graceMs === 1000, 'bounded shutdown contract');

  // A helper restart must invalidate the in-memory snapshot registry. This is
  // the child-side half of the host supervisor's old-process-killed check.
  const restarted = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const restartedLines = createInterface({ input: restarted.stdout });
  const restartedWaiters = new Map();
  restartedLines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = restartedWaiters.get(message.id);
      if (waiter) { restartedWaiters.delete(message.id); waiter(message); }
    } catch { /* ignore non-JSON diagnostics */ }
  });
  const restartedCall = (id, method, params = {}) => {
    const response = new Promise((resolve) => restartedWaiters.set(id, resolve));
    restarted.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  const restartedInit = await restartedCall(1, 'initialize');
  assert(restartedInit.result?.generation && restartedInit.result.generation !== helperGeneration, 'fresh helper generation advances');
  const stale = await restartedCall(2, 'act', staleAction);
  assert(stale.error?.message === 'snapshot_spent_or_unknown', 'old snapshot is invalid after helper restart');
  await restartedCall(3, 'shutdown');
  restarted.stdin.end();
  await new Promise((resolve) => restarted.on('close', resolve));
  console.log('Rust fixture protocol checks complete');
} finally {
  child.stdin.end();
}

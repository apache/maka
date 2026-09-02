import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const [helperPath, hwndText, requestedValue] = process.argv.slice(2);
if (!helperPath || !hwndText) {
  console.error('usage: node notepad-observe-probe.mjs <helper.exe> <hwnd>');
  process.exit(2);
}
const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
let id = 1;
const pending = new Map();
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  waiter(message);
});
const call = (method, params = {}) => new Promise(resolve => {
  const requestId = id++;
  pending.set(requestId, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
});
const initialized = await call('initialize');
const listed = await call('list_windows');
const observed = await call('observe', { hwnd: Number(hwndText) });
let action = null;
let after = null;
if (requestedValue !== undefined && observed.result?.tree?.nodes) {
  const node = observed.result.tree.nodes.find(candidate =>
    candidate.actions?.includes('set_value') && candidate.patterns?.includes('Value'));
  if (node) {
    action = await call('act', {
      snapshotId: observed.result.snapshotId,
      elementToken: node.token,
      op: 'set_value',
      value: requestedValue,
    });
    after = await call('observe', { hwnd: Number(hwndText) });
  } else {
    action = { error: { code: -32001, message: 'value_pattern_not_exposed' } };
  }
}
console.log(JSON.stringify({
  initialize: initialized.result,
  target: listed.result?.windows?.find(window => window.hwnd === Number(hwndText)) ?? null,
  observeError: observed.error ?? null,
  action,
  after: after?.result?.tree ?? null,
  tree: observed.result?.tree ?? null,
  elements: observed.result?.elements ?? null,
}, null, 2));
await call('shutdown');
child.stdin.end();

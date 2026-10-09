/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Entry point of the bot sidecar: runs Maka's chat bots against the local
// Runtime Host of one State Root and talks to the client over stdio, one
// JSON object per line (docs/bots-sidecar.md).
//
//   node main.mjs --maka-repo <checkout> --state-root <root>
//
// stdout carries only protocol lines, so everything that would print there,
// including what the Maka modules log, is sent as `log` events instead. The
// sidecar stops when the client says `shutdown`, closes stdin, or sends
// SIGTERM.

import readline from 'node:readline';
import { format } from 'node:util';
import { MakaCheckoutError, loadMaka } from './maka.mjs';
import { CommandError, SIDECAR_PROTOCOL_VERSION, createBotSidecar, describe } from './sidecar.mjs';
import {
  TELEGRAM_API_ORIGIN,
  TELEGRAM_API_ORIGIN_ENV,
  observeTelegramConflicts,
  parseTestOrigin,
  redirectTelegramApi,
} from './telegram-api.mjs';

/** Exit status after a `fatal` event: retrying cannot help. */
const EXIT_FATAL = 2;

const writeLine = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

/**
 * Exits once everything written so far has reached the pipe: a write to a
 * pipe is asynchronous on macOS, and `process.exit` would drop it.
 */
function exitAfterFlush(code) {
  setTimeout(() => process.exit(code), 1_000).unref();
  process.stdout.write('', () => process.exit(code));
}
const emit = (event) => writeLine(event);
const log = (level, message) => emit({ event: 'log', level, message });

// The client reading stdout went away: nothing is left to serve.
process.stdout.on('error', () => process.exit(0));

for (const [method, level] of [
  ['debug', 'info'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
]) {
  console[method] = (...args) => log(level, format(...args));
}
process.on('uncaughtException', (error) => {
  log('error', `uncaught exception: ${error?.stack ?? describe(error)}`);
  exitAfterFlush(1);
});
// Electron's main process, where Desktop runs these bots, logs an unhandled
// rejection and keeps going; so does the sidecar.
process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${reason?.stack ?? describe(reason)}`);
});

/** Reports why the sidecar cannot run, exits, and never resolves. */
function fatal(code, message) {
  emit({ event: 'fatal', code, message });
  exitAfterFlush(EXIT_FATAL);
  return new Promise(() => {});
}

/** `{ values }`, or `{ error }` for arguments the sidecar cannot run with. */
function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name !== '--maka-repo' && name !== '--state-root') return { error: `unknown argument ${name}` };
    if (!value) return { error: `${name} needs a value` };
    values[name.slice(2)] = value;
  }
  if (!values['maka-repo'] || !values['state-root']) {
    return { error: 'usage: main.mjs --maka-repo <checkout> --state-root <root>' };
  }
  return { values };
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.error) await fatal('invalid_arguments', parsed.error);
const args = parsed.values;
let maka;
try {
  maka = await loadMaka(args['maka-repo']);
} catch (error) {
  await fatal(
    'checkout_unavailable',
    error instanceof MakaCheckoutError ? error.message : `cannot load Maka: ${describe(error)}`,
  );
}

const origins = [TELEGRAM_API_ORIGIN];
const testOrigin = process.env[TELEGRAM_API_ORIGIN_ENV];
if (testOrigin) {
  let origin;
  try {
    origin = parseTestOrigin(testOrigin);
  } catch (error) {
    await fatal('invalid_arguments', describe(error));
  }
  redirectTelegramApi(maka.undici, origin);
  origins.push(origin);
  log('warn', `Telegram Bot API requests go to ${origin} (${TELEGRAM_API_ORIGIN_ENV}, for tests)`);
}

const sidecar = createBotSidecar({ maka, stateRoot: args['state-root'], emit, log });
observeTelegramConflicts((conflict) => sidecar.telegramConflict(conflict), { origins });

let stopping;
function stop() {
  stopping ??= sidecar.close().finally(() => exitAfterFlush(0));
  return stopping;
}

async function answer(line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    log('warn', 'ignored a line that is not JSON');
    return;
  }
  const id = command?.id;
  if (!Number.isSafeInteger(id) || id < 0) {
    log('warn', 'ignored a command without an id');
    return;
  }
  if (command.command === 'shutdown') {
    await sidecar.close();
    writeLine({ id, ok: true });
    return stop();
  }
  try {
    writeLine({ id, ok: true, ...(await sidecar.handle(command)) });
  } catch (error) {
    const code = error instanceof CommandError ? error.code : 'failed';
    writeLine({ id, ok: false, error: { code, message: describe(error) } });
  }
}

readline
  .createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  .on('line', (line) => {
    if (line.trim()) void answer(line);
  })
  .on('close', () => void stop());
process.on('SIGTERM', () => void stop());

sidecar.start();
emit({
  event: 'ready',
  protocol: SIDECAR_PROTOCOL_VERSION,
  compatibilityEpoch: maka.protocol.RUNTIME_HOST_COMPATIBILITY_EPOCH,
  pid: process.pid,
});

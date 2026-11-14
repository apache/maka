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

(mainModule, target, v8Version) => {
  const { core, internals } = globalThis.__bootstrap;
  core.setBuildInfo(target);
  const load = (path) => core.loadExtScript(`ext:${path}`);
  const { DOMException } = load('deno_web/01_dom_exception.js');
  core.registerErrorBuilder(
    'DOMExceptionInvalidCharacterError',
    (message) => new DOMException(message, 'InvalidCharacterError'),
  );
  for (const [path, names] of [
    ['deno_web/01_dom_exception.js', ['DOMException']],
    ['deno_web/02_event.js', ['Event', 'EventTarget', 'CustomEvent']],
    ['deno_web/02_timers.js', ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']],
    ['deno_web/00_url.js', ['URL', 'URLSearchParams']],
    [
      'deno_web/08_text_encoding.js',
      ['TextEncoder', 'TextDecoder', 'TextEncoderStream', 'TextDecoderStream'],
    ],
    ['deno_web/03_abort_signal.js', ['AbortController', 'AbortSignal']],
    ['deno_web/06_streams.js', ['ReadableStream', 'WritableStream', 'TransformStream']],
    ['deno_web/09_file.js', ['Blob', 'File']],
    [
      'deno_web/13_message_port.js',
      ['MessageChannel', 'MessagePort', 'MessageEvent', 'structuredClone'],
    ],
    [
      'deno_web/15_performance.js',
      ['performance', 'Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure'],
    ],
    ['deno_crypto/00_crypto.js', ['crypto', 'Crypto', 'CryptoKey', 'SubtleCrypto']],
    ['deno_fetch/20_headers.js', ['Headers']],
    ['deno_fetch/21_formdata.js', ['FormData']],
    ['deno_fetch/23_request.js', ['Request']],
    ['deno_fetch/23_response.js', ['Response']],
    ['deno_fetch/26_fetch.js', ['fetch']],
  ]) {
    const exports = load(path);
    for (const name of names) globalThis[name] = exports[name];
  }
  const { EventTarget, setEventTargetData } = load('deno_web/02_event.js');
  const { brand } = load('deno_webidl/00_webidl.js');
  Object.setPrototypeOf(globalThis, EventTarget.prototype);
  Object.defineProperty(globalThis, brand, { value: brand });
  setEventTargetData(globalThis);
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
    globalThis[name] = EventTarget.prototype[name].bind(globalThis);
  }
  const { Console, setNoColorFns } = load('deno_web/01_console.js');
  setNoColorFns(
    () => true,
    () => true,
  );
  globalThis.console = new Console((text, level) => core.print(text, level > 1));
  const fs = load('deno_fs/30_fs.js');
  const { FsFile, fsFileConstructorKey, ...files } = fs;
  const { Command } = load('deno_process/40_process.js');
  const { env, exit, hostname, osRelease, execPath } = load('deno_os/30_os.js');
  const { stdin, stdout, stderr } = load('deno_io/12_io.js');
  const errors = {
    BadResource: core.BadResource,
    Interrupted: core.Interrupted,
    NotCapable: core.NotCapable,
  };
  for (const name of [
    'NotFound',
    'ConnectionRefused',
    'ConnectionReset',
    'ConnectionAborted',
    'NotConnected',
    'AddrInUse',
    'AddrNotAvailable',
    'BrokenPipe',
    'PermissionDenied',
    'AlreadyExists',
    'InvalidData',
    'TimedOut',
    'WouldBlock',
    'WriteZero',
    'UnexpectedEof',
    'Http',
    'Busy',
    'NotSupported',
    'FilesystemLoop',
    'IsADirectory',
    'NetworkUnreachable',
    'NotADirectory',
  ]) {
    const ErrorClass = {
      [name]: class extends Error {
        name = name;
      },
    }[name];
    core.registerErrorClass(name, ErrorClass);
    errors[name] = ErrorClass;
  }
  const args = [];
  const version = { v8: v8Version };
  const build = { ...core.build, standalone: false };
  globalThis.Deno = {
    ...files,
    FsFile,
    Command,
    env,
    errors,
    exit,
    hostname,
    osRelease,
    execPath,
    stdin,
    stdout,
    stderr,
    args,
    version,
    build,
    mainModule,
  };
  internals.__nodeBootstrapArgs = {
    runningOnMainThread: true,
    denoArgs: args,
    denoVersion: version,
  };
  for (const [name, module, key] of [
    ['process', 'node:process', 'default'],
    ['Buffer', 'node:buffer', 'Buffer'],
    ['WebSocket', 'ext:deno_websocket/01_websocket.js', 'WebSocket'],
  ]) {
    const load = core.createLazyLoader(module);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        return load()[key];
      },
    });
  }
  delete globalThis.__bootstrap;
};

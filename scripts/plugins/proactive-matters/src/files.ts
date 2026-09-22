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

import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MATTER_STATE_MAX_BYTES } from './matter.js';

/** Immutable content is durable before SQLite publishes its reference. Unreferenced objects are harmless. */
export class MatterFiles {
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    mkdirSync(join(this.root, 'objects'), { recursive: true, mode: 0o700 });
  }
  put(text: string): string {
    const name = `${createHash('sha256').update(text).digest('hex')}.md`;
    const path = join(this.root, 'objects', name);
    if (!existsSync(path)) this.write(path, text, 0o400);
    // Detect accidental edits to an already published object instead of silently changing history.
    if (this.get(name) !== text) throw new Error('Matter document integrity check failed');
    return name;
  }
  get(name: string): string {
    if (!/^[a-f0-9]{64}\.md$/.test(name)) throw new Error('Invalid matter document reference');
    const text = readFileSync(join(this.root, 'objects', name), 'utf8');
    if (`${createHash('sha256').update(text).digest('hex')}.md` !== name)
      throw new Error('Matter document integrity check failed');
    return text;
  }
  objectPath(name: string): string {
    return join(this.root, 'objects', name);
  }
  directory(id: string, activationId: string): string {
    const key = createHash('sha256').update(`${id}:${activationId}`).digest('hex');
    const path = join(this.root, 'runs', key);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  write(path: string, text: string, mode = 0o400): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', mode);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    if (process.platform !== 'win32') {
      const dir = openSync(dirname(path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
  }
  draft(path: string, requested: string): string {
    if (resolve(requested) !== path || realpathSync(dirname(path)) !== dirname(path))
      throw new Error('Use this activation’s draft file from MatterRead');
    const before = lstatSync(path);
    if (!before.isFile()) throw new Error('Draft must not be a symbolic link');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.nlink !== 1 ||
        stat.size > MATTER_STATE_MAX_BYTES
      )
        throw new Error('Draft must be a regular, unlinked file within the state size limit');
      const text = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(text) > MATTER_STATE_MAX_BYTES)
        throw new Error('Draft exceeds state size limit');
      return text;
    } finally {
      closeSync(fd);
    }
  }
}

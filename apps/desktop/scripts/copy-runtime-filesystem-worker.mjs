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

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(desktopRoot, '..', '..', 'packages', 'runtime', 'dist', 'workers', 'filesystem-worker.js');
const target = resolve(desktopRoot, 'resources', 'workers', 'filesystem-worker.js');
const metadata = await stat(source).catch(() => undefined);
if (!metadata?.isFile()) throw new Error(`Runtime filesystem worker bundle is missing: ${source}`);
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);

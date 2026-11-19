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

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const licenseName = (name) =>
  (/^(?:licen[cs]e|unlicense|copying|copyright|notice|credits)(?:$|[-_.])/i.test(name) ||
    /[-_.]licen[cs]e(?:$|\.)/i.test(name)) &&
  !/\.(?:rs|py|h|cc|c|json|toml|sh|js)$/i.test(name);

export async function licenseFiles(directory, licenseDirectory = false) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'target') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      found.push(
        ...(await licenseFiles(path, licenseDirectory || /^licen[cs]es?$/i.test(entry.name))),
      );
    else if (entry.isFile() && (licenseName(entry.name) || licenseDirectory)) found.push(path);
  }
  return found.sort();
}

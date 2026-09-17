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
// Test launcher only: use the real app, not MAKA_E2E's FakeBackend.
const { app } = require('electron');
const { join, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = process.env.MAKA_MANAGED_SMOKE_ROOT;
if (!root || !isAbsolute(root) || app.isPackaged) throw new Error('Isolated smoke root required');
const desktop = join(__dirname, '..', 'apps', 'desktop');
app.setAppPath(desktop);
app.setPath('userData', join(root, 'user-data'));
process.chdir(desktop);
import(pathToFileURL(join(desktop, 'dist/main/main.js')).href).catch((error) => {
  console.error(error);
  app.exit(1);
});

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

// Windows resolves `npm` to npm.cmd, and a bare `npm` never reaches it: libuv's
// process launcher tries only .com and .exe and ignores PATHEXT, and Node
// refuses to launch a .cmd without a shell at all. So every npm subprocess on
// Windows has to go through the shell, and every one on POSIX must not — there
// the extensionless shim resolves directly and a shell would only add quoting.
//
// This is one rule with more than one caller, and getting it wrong is invisible
// until something actually runs on Windows, which until now nothing did.
export function npmSpawnOptions(options = {}, platform = process.platform) {
  return { ...options, shell: platform === 'win32' };
}

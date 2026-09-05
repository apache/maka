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

import { GLOBSTAR, Minimatch, type MinimatchOptions } from 'minimatch';

export type WindowsGlobPatternPart = string | RegExp | typeof GLOBSTAR;

const WINDOWS_GLOB_MATCH_OPTIONS = {
  nocase: true,
  windowsPathsNoEscape: true,
  nonegate: true,
  nocomment: true,
  optimizationLevel: 2,
  platform: 'win32',
  nocaseMagicOnly: true,
} satisfies MinimatchOptions;

export function compileWindowsGlobPattern(pattern: string): WindowsGlobPatternPart[][] {
  return new Minimatch(pattern, WINDOWS_GLOB_MATCH_OPTIONS).set as WindowsGlobPatternPart[][];
}

/**
 * Returns the deepest directory that a non-globstar pattern can enter. An
 * absent result means the pattern contains GLOBSTAR and therefore has no
 * static traversal bound. Dot path components advance matcher state without
 * entering another directory and are excluded from the depth.
 */
export function windowsGlobTraversalDepth(pattern: string): number | undefined {
  let maximum = 0;
  for (const branch of compileWindowsGlobPattern(pattern)) {
    if (branch.includes(GLOBSTAR)) return undefined;
    const depth = branch.slice(0, -1).filter((part) => part !== '' && part !== '.').length;
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

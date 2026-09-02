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

/**
 * Windows' platform adapter is deliberately only a naming seam.
 *
 * The model-facing action space, maka.cu/2 protocol, snapshot authority and
 * supervised-child lifecycle are shared with macOS. Keeping a second backend
 * here would recreate the old private `maka.cu.windows/0` contract and make
 * the two platforms drift again. Windows-specific UIA/WGC behaviour belongs
 * in the native executor behind the same protocol.
 */
import {
  createMakaCuBackend,
  type MakaCuBackend,
  type MakaCuBackendOptions,
} from './maka-cu-backend.js';

export type WindowsCuBackendOptions = MakaCuBackendOptions;

export function createWindowsCuBackend(options: WindowsCuBackendOptions): MakaCuBackend {
  return createMakaCuBackend(options);
}

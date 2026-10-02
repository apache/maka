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

import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';
import { stagingBindings } from '../model/composer-staging-binding.js';

export function createComposerStagingCommands(): ComposerStagingCommands {
  const binding: { current?: ComposerStagingCommands } = {};
  const requireOwner = () => {
    if (!binding.current) throw new Error('ComposerStagingProvider is not mounted');
    return binding.current;
  };
  const commands: ComposerStagingCommands = {
    captureSubmission: () => requireOwner().captureSubmission(),
    addQuote: (quote) => requireOwner().addQuote(quote),
    resetImageNotice: (key) => requireOwner().resetImageNotice(key),
    transferImageNotice: (from, to) => requireOwner().transferImageNotice(from, to),
  };
  stagingBindings.set(commands, binding);
  return commands;
}

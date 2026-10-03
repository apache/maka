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

import type { ComposerSubmissionCommands } from '../model/composer-submission-contract.js';
import { submissionBindings } from '../model/composer-submission-binding.js';

export function createComposerSubmissionCommands(): ComposerSubmissionCommands {
  const binding: { current?: ComposerSubmissionCommands } = {};
  const requireOwner = () => {
    if (!binding.current) throw new Error('ComposerSubmissionProvider is not mounted');
    return binding.current;
  };
  const commands: ComposerSubmissionCommands = {
    beginEditUserMessage: (turnId) => requireOwner().beginEditUserMessage(turnId),
    handleTurnFooterAction: (turnId, actionId) => requireOwner().handleTurnFooterAction(turnId, actionId),
  };
  submissionBindings.set(commands, binding);
  return commands;
}

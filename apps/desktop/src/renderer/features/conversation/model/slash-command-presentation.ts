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

import { GitBranch, MessageCircleQuestion, Minimize2, Network } from '@maka/ui/icons';
import type { ComposerSlashCommandOption } from '@maka/ui';
import type { SlashCommandIdForSurface } from '@maka/core/slash-command-catalog';
import type { getShellCopy } from '../../../locales/shell-copy.js';
export function desktopSlashCommandPresentation(copy: ReturnType<typeof getShellCopy>['app']['slashCommands']) {
  const presentation: Record<
        SlashCommandIdForSurface<'desktop'>,
        Omit<ComposerSlashCommandOption, 'id'>
      > = {
        compact: {
          ...copy.compact,
          keywords: ['compact', 'context', '压缩', '上下文'],
          Icon: Minimize2,
        },
        side: {
          ...copy.side,
          keywords: ['side', 'btw', '侧聊', '追问'],
          Icon: MessageCircleQuestion,
        },
        swarm: {
          ...copy.swarm,
          keywords: ['swarm', 'multi-agent', '多智能体'],
          Icon: Network,
        },
        graph: {
          ...copy.graph,
          keywords: ['graph', 'agent graph', '智能体图'],
          Icon: GitBranch,
        },
      };
  return presentation;
}

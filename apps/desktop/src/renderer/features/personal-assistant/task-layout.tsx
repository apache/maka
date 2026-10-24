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

import type { ComponentProps } from 'react';
import { PersonalAssistantChatLayout } from './chat-presentation.js';
import { PersonalAssistantTaskFloat } from './task-float.js';
export function PersonalAssistantTaskLayout({ session, ...props }: ComponentProps<typeof PersonalAssistantChatLayout> & { session?: { id: string; labels?: readonly string[] } }) {
  const layout = <PersonalAssistantChatLayout session={session} {...props} />;
  return session?.labels?.includes('personal-assistant') ? <div className="personal-assistant-chat-frame" hidden={props.hidden}>{layout}{!props.hidden && <PersonalAssistantTaskFloat key={session.id} sessionId={session.id} />}</div> : layout;
}

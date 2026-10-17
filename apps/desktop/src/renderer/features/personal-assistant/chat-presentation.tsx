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

import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react';
import { ChatSurfaceLayout, Composer, useUiLocale } from '@maka/ui';
import { PersonalAssistantAvatar, useAssistantAvatar } from './avatar.js';
import { PersonalAssistantTyping } from './typing.js';

type Session = { id: string; labels?: readonly string[] };
function assistantChatClassName(session?: Session) {
  return session?.labels?.includes('personal-assistant') ? 'personal-assistant-chat' : undefined;
}
function assistantComposerProps(session: Session | undefined, locale: string) {
  return assistantChatClassName(session) ? {
    compactControls: true,
    placeholder: ({ 'zh-CN': '聊点什么…', 'zh-TW': '聊點什麼…' } as Record<string, string>)[locale] ?? 'Send a message…',
  } : {};
}

export function PersonalAssistantChatPresentation({ session, visible, children }: {
  session?: Session;
  visible: boolean;
  children(props: { assistantAvatar?: ReactNode; activityContent?: ReactNode }): ReactNode;
}) {
  const enabled = !!assistantChatClassName(session);
  const avatar = useAssistantAvatar(enabled, session?.id);
  const assistantAvatar = useMemo(() => enabled ? <PersonalAssistantAvatar avatar={avatar} /> : undefined, [enabled, avatar]);
  return children({
    assistantAvatar,
    activityContent: enabled && visible && session ? <PersonalAssistantTyping key={session.id} sessionId={session.id} avatar={assistantAvatar} /> : undefined,
  });
}

const AssistantChatContext = createContext<Session | undefined>(undefined);
export function PersonalAssistantChatLayout({ session, onboarding, ...props }: ComponentProps<typeof ChatSurfaceLayout> & { session?: Session; onboarding?: boolean }) {
  return <AssistantChatContext.Provider value={session}>
    <ChatSurfaceLayout data-maka-onboarding={onboarding ? 'true' : undefined} data-session-history-surface="true" {...props} className={[props.className, assistantChatClassName(session)].filter(Boolean).join(' ') || undefined} />
  </AssistantChatContext.Provider>;
}
export function PersonalAssistantComposer(props: ComponentProps<typeof Composer>) {
  const session = useContext(AssistantChatContext);
  const locale = useUiLocale();
  return <Composer {...props} {...assistantComposerProps(session, locale)} />;
}

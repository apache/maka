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

import { useEffect, useState } from 'react';
import { useUiLocale } from '@maka/ui';
import { getPersonalAssistantChatCopy } from './chat-copy.js';
import { DEFAULT_ASSISTANT_AVATAR, assistantAvatarSchema, type AssistantAvatar } from '@maka/runtime-host/protocol';
import { usePersonalAssistantServices } from './services.js';
import { disconnectedAvatarState } from './chat-behavior.js';
import { originalHost } from './navigation.js';

type AvatarView = AssistantAvatar & { imageUrl?: string };

export function useAssistantAvatar(enabled: boolean, sessionId?: string) {
  const services = usePersonalAssistantServices();
  const [state, setState] = useState<{ scope?: string; avatar: AvatarView }>({ avatar: DEFAULT_ASSISTANT_AVATAR });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let cachedImage: { id: string; url: string } | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const host = sessionId
          ? originalHost(sessionId, (await services.hostSnapshot()).entries).host
          : await services.defaultHost();
        const result = await services.call('assistant.avatar', {}, host);
        const avatar: AvatarView = assistantAvatarSchema.parse(result.avatar);
        if (avatar.image) {
          if (cachedImage?.id !== avatar.image.id) {
            let data = '';
            while (live && data.length < avatar.image.length) {
              const chunk = await services.call('assistant.avatar-image', { id: avatar.image.id, offset: data.length }, host);
              if (chunk.id !== avatar.image.id || chunk.offset !== data.length || typeof chunk.data !== 'string'
                || !chunk.data.length || data.length + chunk.data.length > avatar.image.length) throw Error('Invalid avatar image');
              data += chunk.data;
            }
            if (!live) return;
            cachedImage = { id: avatar.image.id, url: `data:${avatar.image.mimeType};base64,${data}` };
          }
          avatar.imageUrl = cachedImage.url;
        } else cachedImage = undefined;
        if (live) setState((old) => old.scope === sessionId && old.avatar.emoji === avatar.emoji && old.avatar.background === avatar.background && old.avatar.imageUrl === avatar.imageUrl
          ? old : { scope: sessionId, avatar });
      } catch {
        // A disconnected Host must not display another Host's identity.
        if (live) setState((old) => disconnectedAvatarState(old, sessionId, DEFAULT_ASSISTANT_AVATAR));
      } finally {
        if (live) timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, sessionId, services]);
  return enabled && state.scope === sessionId ? state.avatar : DEFAULT_ASSISTANT_AVATAR;
}

export function PersonalAssistantAvatar({ avatar, variant = 'chat' }: { avatar: AvatarView; variant?: 'chat' | 'navigation' }) {
  const copy = getPersonalAssistantChatCopy(useUiLocale());
  return <span className="personal-assistant-avatar" data-variant={variant} role="img" aria-label={copy.avatarLabel}
    style={variant === 'chat' ? { backgroundColor: avatar.background } : undefined}>
    {avatar.imageUrl ? <img src={avatar.imageUrl} alt="" draggable={false} /> : avatar.emoji}
  </span>;
}

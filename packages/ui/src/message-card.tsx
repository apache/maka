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

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Button, Card } from '@astryxdesign/core';
import { Link } from '@astryxdesign/core/Link';
import { isAssistantCard, type AssistantCard, type AssistantCardAction } from '@maka/core/assistant-card';
import { MarkdownImage } from './markdown-image.js';
import { useUiLocale } from './locale-context.js';
import { assistantChatCopy } from './assistant-chat-copy.js';
import { redactSecrets } from './redact.js';

/** A user click submits a request through the host's normal chat delivery path. */
export const MessageCardSendContext = createContext<((text: string) => Promise<boolean>) | undefined>(undefined);

export interface MessageCardActions {
  read(cardId: string): Promise<{ selectedKey: string | null }>;
  choose(cardId: string, actionKey: string): Promise<{ selectedKey: string }>;
}
export const MessageCardActionsContext = createContext<MessageCardActions | undefined>(undefined);

/** One shared rendering for desktop and web history. */
export function MessageCard({ card, messageId, imageDisplay = 'image' }: {
  messageId?: string;
  card: AssistantCard;
  imageDisplay?: 'image' | 'link';
}) {
  const send = useContext(MessageCardSendContext);
  const actions = useContext(MessageCardActionsContext);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setSelected(null);
    setLoaded(false);
    if (!actions || !messageId) return;
    const refresh = async () => {
      try {
        const status = await actions.read(messageId);
        if (!live) return;
        if (status.selectedKey !== null) setSelected(status.selectedKey);
        setLoaded(true);
        if (status.selectedKey !== null) return;
      } catch { /* Keep unknown cards disabled; retry when the Host reconnects. */ }
      if (live) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [actions, messageId]);
  const locked = pending || selected !== null || (actions ? !messageId || !loaded : !send);
  async function submit(a: AssistantCardAction, key: string) {
    if (locked || sending.current) return;
    sending.current = true;
    setPending(true);
    setFailed(false);
    try {
      if (actions && messageId) setSelected((await actions.choose(messageId, key)).selectedKey);
      else if (send && await send(a.value)) setSelected(key);
      else setFailed(true);
    } catch { setFailed(true); }
    finally { sending.current = false; setPending(false); }
  }
  const copy = assistantChatCopy(useUiLocale());
  if (!isAssistantCard(card)) return null;
  const action = (a: AssistantCardAction, index: number, itemIndex: number) => a.kind === 'link'
    ? (pending || selected !== null
      ? <span key={index} className="maka-message-card-disabled-link" aria-disabled="true">{redactSecrets(a.label)}</span>
      : <Link key={index} href={a.value} isExternalLink type="inherit" hasUnderline>{redactSecrets(a.label)}</Link>)
    : <Button key={index} type="button" label={redactSecrets(a.label)} size="sm" variant="secondary" className="maka-message-card-reply"
        isDisabled={locked} onClick={() => void submit(a, `${itemIndex}:${index}`)}>{selected === `${itemIndex}:${index}` ? copy.cardSent : redactSecrets(a.label)}</Button>;
  const single = card.items.length === 1;
  const cover = (item: AssistantCard['items'][number]) => item.image && <div className="maka-message-card-cover">{imageDisplay === 'link'
    ? <Link href={item.image.url} isExternalLink type="inherit" hasUnderline>{redactSecrets(item.image.alt)}</Link>
    : <MarkdownImage src={item.image.url} alt={redactSecrets(item.image.alt)} redacted={redactSecrets(item.image.url) !== item.image.url} />}</div>;
  return <Card className="maka-message-card" data-card-type={card.type} data-single={single} aria-label={redactSecrets(card.title)}>
    <div className="maka-message-card-heading"><h3>{redactSecrets(card.title)}</h3></div>
    <div className="maka-message-card-body" tabIndex={0}>
      {card.description && <p className="maka-message-card-intro">{redactSecrets(card.description)}</p>}
      <div className="maka-message-card-items" data-count={card.items.length}>
        {card.items.map((item, index) => <section key={index} className="maka-message-card-item">
          {cover(item)}
          <div className="maka-message-card-content">
            {(!single || item.title !== card.title) && <h4>{redactSecrets(item.title)}</h4>}
            {!!item.facts?.length && <dl>{item.facts.map((fact, n) => <div key={n}><dt>{redactSecrets(fact.label)}</dt><dd>{redactSecrets(fact.value)}</dd></div>)}</dl>}
            {item.description && (!single || item.description !== card.description) && <p>{redactSecrets(item.description)}</p>}
          </div>
        </section>)}
      </div>
    </div>
    {card.items.some(item => item.actions?.length) && <div className="maka-message-card-actions">{card.items.flatMap((item, index) => item.actions?.map((a, n) =>
      <span className="maka-message-card-action" key={`${index}:${n}`} title={redactSecrets(item.title)}>{action(a, n, index)}</span>) ?? [])}</div>}
    {failed && <div className="maka-message-card-hint" role="alert">{copy.cardFailed}</div>}
  </Card>;
}

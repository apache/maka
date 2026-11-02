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

import { isAssistantCard, type AssistantCard } from '@maka/core/assistant-card';

export interface PetCardPort {
  cardAction(input: { target: string; cardId: string; actionKey?: string }): Promise<{ selectedKey: string | null }>;
  openLink(url: string): Promise<void>;
}

/** Only the visible card is observed. Selection remains owned by the Host. */
export class PetCardView {
  private identity = '';
  private dispose: (() => void) | undefined;
  pending = false;
  constructor(private element: HTMLElement, private port: PetCardPort) {}
  show(target?: string, cardId?: string, card?: AssistantCard) {
    const valid = target && cardId && isAssistantCard(card);
    const identity = valid ? JSON.stringify([target, cardId, card]) : '';
    if (identity === this.identity) return;
    this.dispose?.();
    this.identity = identity;
    this.pending = false;
    this.element.replaceChildren();
    this.element.hidden = !valid;
    if (!valid) return;
    let live = true, loaded = false, selected: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error = '';
    const document = this.element.ownerDocument;
    const add = (parent: HTMLElement, tag: string, text: string, className = '') => {
      const node = document.createElement(tag);
      node.textContent = text; node.className = className; parent.append(node); return node;
    };
    const draw = () => {
      this.element.replaceChildren();
      add(this.element, 'h2', card.title, 'pet-card-title');
      const body = add(this.element, 'div', '', 'pet-card-body');
      body.tabIndex = 0;
      if (card.description) add(body, 'p', card.description, 'pet-card-description');
      const actions = add(this.element, 'div', '', 'pet-card-actions');
      actions.hidden = !card.items.some(item => item.actions?.length);
      card.items.forEach((item, i) => {
        const section = add(body, 'section', '', 'pet-card-item');
        if (item.title !== card.title || card.items.length > 1) add(section, 'h3', item.title);
        if (item.description) add(section, 'p', item.description);
        for (const fact of item.facts ?? []) {
          const row = add(section, 'div', '', 'pet-card-fact');
          add(row, 'span', fact.label); add(row, 'span', fact.value);
        }
        item.actions?.forEach((action, j) => {
          const key = `${i}:${j}`;
          const button = add(actions, 'button', selected === key ? '已发送' : action.label) as HTMLButtonElement;
          button.type = 'button';
          button.title = action.label;
          button.setAttribute('aria-label', selected === key ? `${action.label} · 已发送` : action.label);
          button.disabled = !loaded || this.pending || selected !== null;
          button.onclick = async () => {
            if (!live || !loaded || this.pending || selected !== null) return;
            this.pending = true; error = ''; draw();
            try {
              if (action.kind === 'link') await this.port.openLink(action.value);
              else {
                const result = await this.port.cardAction({ target, cardId, actionKey: key });
                if (live) selected = result.selectedKey;
              }
            } catch { if (live) error = '未确认发送成功，可以重试'; }
            finally { if (live) { this.pending = false; draw(); } }
          };
        });
      });
      if (error) add(this.element, 'p', error, 'pet-card-error').setAttribute('role', 'status');
    };
    const refresh = async () => {
      try {
        const result = await this.port.cardAction({ target, cardId });
        if (!live) return;
        const changed = !loaded || (result.selectedKey !== null && result.selectedKey !== selected);
        loaded = true;
        if (result.selectedKey !== null) selected = result.selectedKey;
        if (changed && !this.pending) { error = ''; draw(); }
      } catch {
        if (live && !loaded) { error = '暂时无法读取选项状态，正在重试'; draw(); }
      } finally {
        if (live && selected === null) timer = setTimeout(refresh, 3000);
      }
    };
    this.dispose = () => { live = false; clearTimeout(timer); };
    draw(); void refresh();
  }
}

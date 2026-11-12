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

import { useId, type ReactNode } from 'react';
import type { CheckinCard } from '@maka/core/session-checkin';
import { Button as UiButton, useUiLocale } from '@maka/ui';
import { ICON_SIZE, X } from '@maka/ui/icons';
import { getCheckinCopy, type CheckinCopy } from '../locales/checkin-copy.js';
import { useCheckin } from '../controller/use-checkin.js';
import { checkinCardKey } from '../model/checkin.js';

/**
 * The new-task screen: check-in cards pinned to the top right of the chat in
 * place of the greeting. With no cards it is the greeting alone, rendered as
 * the empty state's own child so it keeps its centring. A check-in that does
 * not run says nothing here; Settings is where a missing model is explained.
 */
export function CheckinHome(props: { hero: ReactNode }) {
  const checkin = useCheckin();
  const copy = getCheckinCopy(useUiLocale());
  const hasCards = checkin.cards.length > 0;
  const showSection = checkin.enabled && (hasCards || checkin.running || checkin.notice);
  return (
    <>
      {showSection ? (
        <section className="maka-checkin" aria-label={copy.sectionLabel} aria-busy={checkin.running || undefined}>
          {checkin.notice ? (
            <p className="maka-checkin-status" role="status">
              {checkin.notice.outcome === 'stale' ? copy.stale : copy.failed}
            </p>
          ) : checkin.running && !hasCards ? (
            <span className="maka-checkin-dots" role="status">
              <span className="maka-visually-hidden">{copy.running}</span>
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </span>
          ) : null}
          {hasCards ? (
            <ul className="maka-checkin-cards">
              {checkin.cards.map((card) => {
                const key = checkinCardKey(card);
                return (
                  <li key={key}>
                    <CheckinCardView
                      card={card}
                      copy={copy}
                      busy={checkin.busyKey === key}
                      disabled={checkin.busyKey !== undefined}
                      onAct={() => void checkin.act(card)}
                      onEdit={(text) => checkin.edit(card, text)}
                      onDismiss={() => checkin.dismiss(card)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
      {hasCards ? null : props.hero}
    </>
  );
}

/**
 * The title and the close button on top, what the action will do in the
 * middle, the action and a way to change it at the bottom. Hover or keyboard
 * focus makes the card solid and opens all of it with the record's words that
 * justify it.
 */
function CheckinCardView(props: {
  card: CheckinCard;
  copy: CheckinCopy;
  busy: boolean;
  disabled: boolean;
  onAct(): void;
  onEdit(text: string): void;
  onDismiss(): void;
}) {
  const { card, copy } = props;
  const detailsId = useId();
  const body =
    card.action === 'answer'
      ? card.evidence.quote
      : (card.instruction ?? (card.action === 'resume' ? copy.resumeHint : card.evidence.quote));
  return (
    <article className="maka-checkin-card" aria-describedby={detailsId}>
      <header className="maka-checkin-card-header">
        <h3 className="maka-checkin-card-title">{card.title}</h3>
        <UiButton
          className="maka-checkin-card-dismiss"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<X size={ICON_SIZE.meta} aria-hidden="true" />}
          label={copy.dismiss}
          isDisabled={props.disabled}
          onClick={props.onDismiss}
        />
      </header>
      <p className="maka-checkin-card-action">{body}</p>
      <footer className="maka-checkin-card-footer">
        <UiButton
          variant="primary"
          size="sm"
          label={copy.actions[card.action]}
          isLoading={props.busy}
          isDisabled={props.disabled}
          onClick={props.onAct}
        />
        {/* An answer happens in the task itself; every other card can be changed there. */}
        {card.action === 'answer' ? null : (
          <UiButton
            className="maka-checkin-card-instead"
            variant="ghost"
            size="sm"
            label={copy.instead}
            isDisabled={props.disabled}
            onClick={() => props.onEdit(body)}
          />
        )}
      </footer>
      <div className="maka-checkin-card-details" id={detailsId} role="tooltip">
        <p className="maka-checkin-card-details-title">{card.title}</p>
        <p className="maka-checkin-card-details-session">{copy.from(card.sessionName)}</p>
        {card.instruction ? <p className="maka-checkin-card-details-action">{card.instruction}</p> : null}
        <p className="maka-checkin-card-details-label">{copy.why}</p>
        <blockquote className="maka-checkin-card-details-evidence">{card.evidence.quote}</blockquote>
      </div>
    </article>
  );
}

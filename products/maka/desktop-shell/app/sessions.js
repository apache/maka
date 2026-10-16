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

// The session list: a live `agent.catalog` subscription and the sidebar.

import { div } from 'gpui-kit';
import { v_flex, h_flex, Button } from 'gpui-base';
import { button } from './composer.js';
import { query, subscribe, next, close, log } from './host.js';

const LIST = { filter: 'all', position: { kind: 'start' } };
const RETRY_MS = 2000;
/** Pages read after the subscribed first one; the Host pages at most 32 sessions in id order. */
const MAX_PAGES = 32;

export class SessionCatalog {
  /**
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    /** Every listed session, newest first. Replaced, never edited. */
    this.sessions = [];
    /** The subscribed first page, and the pages after it as last read. */
    this.first = [];
    this.rest = [];
    this.reading = 0;
    this.needsYou = 0;
    /** "connecting", "live" or "offline". */
    this.state = 'connecting';
    this.revision = null;
    this.handle = null;
    this.restarting = false;
  }

  /**
   * Holds one catalog subscription with a single `next()` loop. When it fails
   * or ends, one `agent.list` query keeps the sidebar current and the
   * subscription is opened again after a pause.
   */
  async run(cx) {
    for (;;) {
      try {
        this.handle = await subscribe('agent', 'catalog', LIST);
        log(`catalog: subscribed as ${this.handle}`);
        for (;;) {
          const page = await next(this.handle);
          if (page === null) break;
          this.apply(page, 'live');
        }
        if (!this.restarting) log('catalog: the Host ended the subscription');
      } catch (error) {
        // A restart closes the handle under the loop; its next() then fails.
        if (!this.restarting) this.hooks.report(`Session list: ${error.message}`);
      } finally {
        if (this.handle !== null) await close(this.handle).catch(() => {});
        this.handle = null;
      }
      if (this.restarting) {
        this.restarting = false;
        continue;
      }
      this.state = 'offline';
      this.hooks.changed();
      try {
        this.apply(await query('agent', 'list', LIST), 'offline');
      } catch (error) {
        this.hooks.report(`Session list: ${error.message}`);
      }
      await cx.sleep(RETRY_MS);
    }
  }

  /**
   * Reopens the subscription at the start. After a change the Host reads the
   * catalog again from the first id it last sent, and ids are random, so a
   * new session can sort before that id and fall outside the window; the TUI
   * likewise reopens its catalog watch after creating a session.
   */
  restart() {
    if (this.handle === null || this.restarting) return;
    this.restarting = true;
    close(this.handle).catch(() => {});
  }

  apply(page, state) {
    if (state === 'live' && page.before !== null) {
      log('catalog: sessions sort before the window; reopening at the start');
      this.restart();
      return;
    }
    // The catalog answers after every commit; an unchanged revision is the same page.
    if (page.revision === this.revision && state === this.state) return;
    this.revision = page.revision;
    this.first = page.sessions;
    this.needsYou = page.needsYouCount;
    this.state = state;
    if (page.after === null) {
      this.reading += 1;
      this.rest = [];
    } else {
      this.readRest(page);
    }
    this.publish();
  }

  /**
   * Reads the pages after the first at its revision. Sessions are paged in
   * id order, so the newest can be on any page. A conflict means the catalog
   * changed meanwhile; the page that change brings reads them again.
   */
  async readRest(page) {
    const reading = ++this.reading;
    const rest = [];
    let after = page.after;
    try {
      for (let count = 0; after !== null && count < MAX_PAGES; count += 1) {
        const next = await query('agent', 'list', {
          filter: LIST.filter,
          position: { kind: 'after', revision: page.revision, cursor: after },
        });
        if (reading !== this.reading) return;
        rest.push(...next.sessions);
        after = next.after;
      }
    } catch (error) {
      if (reading === this.reading) log(`catalog: later pages: ${error.message}`);
      return;
    }
    this.rest = rest;
    this.publish();
  }

  publish() {
    const byId = new Map(this.rest.map((session) => [session.id, session]));
    for (const session of this.first) byId.set(session.id, session);
    this.sessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    log(`catalog: ${this.sessions.length} sessions, ${this.needsYou} need you`);
    this.hooks.changed();
  }
}

/** A session is waiting on the user (a question or an approval). */
export function needsYou(session) {
  return session.activity === 'waiting';
}

/**
 * @param {SessionCatalog} catalog
 * @param {string | null} selectedId
 * @param {(session: object) => void} select
 * @param {{ enabled: boolean, create: () => void }} create starts a session in the selected one's workspace
 */
/**
 * @param {{ open: boolean, show: () => void }} settings the Settings button at the bottom
 */
export function sidebar(catalog, selectedId, select, create, settings, cx) {
  const theme = cx.theme();
  const summary =
    catalog.needsYou > 0
      ? `${catalog.sessions.length} · ${catalog.needsYou} need you`
      : `${catalog.sessions.length}`;
  return v_flex()
    .w_64()
    .flex_none()
    .h_full()
    .border_r_1()
    .border_color(theme.colors.border)
    .bg(theme.colors.surface)
    .text_color(theme.colors.surface_foreground)
    .child(
      h_flex()
        .px(theme.spacing.lg)
        .py(theme.spacing.md)
        .gap(theme.spacing.sm)
        .items_center()
        .child(div().flex_1().font_weight(600).child('Sessions'))
        .child(div().text_sm().text_color(theme.colors.muted_foreground).child(summary))
        .child(
          button('new-session', 'New', false, !create.enabled, cx)
            .h_6()
            .tooltip('New session in this workspace')
            .on_click(() => create.create()),
        ),
    )
    .child(
      v_flex()
        .id('sessions')
        .flex_1()
        .min_h_0()
        .overflow_y_scrollbar()
        .px(theme.spacing.sm)
        .gap(theme.spacing.xxs)
        .when(catalog.sessions.length === 0, (el) =>
          el.child(
            div()
              .px(theme.spacing.sm)
              .text_sm()
              .text_color(theme.colors.muted_foreground)
              .child(catalog.state === 'connecting' ? 'Loading sessions…' : 'No sessions'),
          ),
        )
        .children(
          catalog.sessions.map((session) =>
            sessionRow(session, session.id === selectedId, select, cx),
          ),
        ),
    )
    .child(
      h_flex()
        .flex_none()
        .px(theme.spacing.sm)
        .py(theme.spacing.sm)
        .border_t_1()
        .border_color(theme.colors.border)
        .child(
          Button.new('open-settings-sidebar')
            .w_full()
            .px(theme.spacing.sm)
            .py(theme.spacing.xs)
            .rounded(theme.radius.md)
            .text_sm()
            .selected(settings.open)
            .when(settings.open, (el) =>
              el.bg(theme.colors.accent).text_color(theme.colors.accent_foreground),
            )
            .when(!settings.open, (el) => el.hover((style) => style.bg(theme.colors.muted)))
            .on_click(() => settings.show())
            .child('Settings'),
        ),
    );
}

function sessionRow(session, selected, select, cx) {
  const theme = cx.theme();
  const state = needsYou(session) ? 'Needs you' : session.activity === 'working' ? 'Working' : null;
  return Button.new(`session-${session.id}`)
    .w_full()
    .px(theme.spacing.sm)
    .py(theme.spacing.xs)
    .rounded(theme.radius.md)
    .selected(selected)
    .when(selected, (el) => el.bg(theme.colors.accent).text_color(theme.colors.accent_foreground))
    .when(!selected, (el) => el.hover((style) => style.bg(theme.colors.muted)))
    .on_click(() => select(session))
    .child(
      v_flex()
        .w_full()
        .min_w_0()
        .gap(theme.spacing.xxs)
        .child(
          div()
            .text_sm()
            .truncate()
            .when(selected, (el) => el.font_weight(600))
            .child(session.title),
        )
        .when(state !== null, (el) =>
          el.child(
            h_flex()
              .gap(theme.spacing.xs)
              .items_center()
              .text_xs()
              .text_color(needsYou(session) ? theme.colors.primary : theme.colors.muted_foreground)
              .child(
                div()
                  .size(6)
                  .rounded(theme.radius.full)
                  .bg(needsYou(session) ? theme.colors.primary : theme.colors.muted_foreground),
              )
              .child(state),
          ),
        ),
    );
}

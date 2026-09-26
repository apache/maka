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

/**
 * Terminal views: what a plugin presents in the Maka TUI. A Remote method
 * registered with a `terminalView` descriptor answers {@link TerminalRequest}
 * with a {@link TerminalReply}; the view is a bounded component tree that
 * says what things are, while the terminal decides layout, focus, scrolling
 * and editing. Text is plain and already localized for `request.locale`.
 */

import type { AuthorizationRequest } from './authorization.js';
import type { Json } from './host.js';
import type { TerminalAppRegistration, TerminalViewBody } from './terminal-app.js';
export type * from './terminal-app.js';
import type {
  TranscriptInitial,
  TranscriptResource,
  TranscriptStore,
} from './terminal-transcript.js';
export type * from './terminal-transcript.js';

export interface TerminalText {
  fallback: string;
  /** By BCP 47 tag, e.g. `zh-CN`; a bare language also matches its regions. */
  translations?: Record<string, string>;
}

/** Where the shell presents a view. */
export type TerminalPlacement =
  /** A page of its own. */
  | { kind: 'page' }
  /** A panel of a session's inspector (session context only). */
  | { kind: 'panel' }
  /** One quiet line above a session's composer (session context only). */
  | { kind: 'status' }
  /** A category of Settings (application context only). */
  | { kind: 'settings' }
  /** Inside other views that declare a slot of this name. */
  | { kind: 'slot'; name: string };

export interface TerminalView {
  version: 8;
  title: TerminalText;
  context: 'application' | 'session';
  placement?: TerminalPlacement;
  /** One narrow glyph, and one or two ASCII characters for plain terminals. */
  icon?: { glyph: string; ascii: string };
  /** A stream of the same package whose items say the view is stale. */
  changes?: string;
  /** Lower first among views of the same placement. */
  order?: number;
}

export type TerminalTone =
  | 'normal'
  | 'strong'
  | 'muted'
  | 'subtle'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error';

export interface TerminalSpan {
  text: string;
  tone?: TerminalTone;
}

export interface TerminalBoundaryOptions {
  /** One lower-border row: text, buttons, or nested rows of those nodes. */
  bottom?: TerminalNode;
  /** Interior cells on each axis, each in the range 0–4. */
  padding?: { horizontal?: number; vertical?: number };
  emphasis?: 'normal' | 'accent';
  /** The kernel animates visible accent activity when motion is enabled. */
  activity?: 'idle' | 'busy';
}

/** A local keyed collection. Only an explicitly selected panel is mounted. */
export interface TerminalCollectionOptions {
  groups: { key: string; label: string }[];
  items: { key: string; group: string; title: string; summary?: string; panel?: TerminalNode }[];
  filter?: { label: string; placeholder?: string };
  initial?: string;
  ratio?: number;
  /** The kernel supplies item/group/before to these declared action fields. */
  movement?: { action: string; item_field: string; group_field: string; before_field: string };
}

export type TerminalTarget =
  /** Read another route of this view; Back returns. */
  | { kind: 'route'; route: Json }
  /** Submit a declared action. */
  | { kind: 'action'; action: string }
  /** Open a Maka session in the shell, such as one the plugin started. */
  | { kind: 'session'; session: string };

/** Keys are unique among siblings, contain no `/`, and stay stable across reads. */
export type TerminalNode =
  | ({ kind: 'collection'; key: string } & TerminalCollectionOptions)
  | { kind: 'column'; key: string; gap?: number; children: TerminalNode[] }
  | { kind: 'row'; key: string; gap?: number; children: TerminalNode[] }
  | ({ kind: 'boundary'; key: string; body: TerminalNode } & TerminalBoundaryOptions)
  | { kind: 'text'; key: string; spans: TerminalSpan[]; clip?: boolean }
  | { kind: 'rule'; key: string }
  | { kind: 'scroll'; key: string; rows: number; child: TerminalNode }
  | { kind: 'split'; key: string; ratio?: number; left: TerminalNode; right: TerminalNode }
  | {
      kind: 'tabs';
      key: string;
      current: string;
      tabs: { id: string; label: string; route: Json }[];
    }
  | {
      kind: 'item';
      key: string;
      title: string;
      detail?: string;
      meta?: string;
      tone?: TerminalTone;
      current?: boolean;
      target: TerminalTarget;
    }
  | {
      kind: 'button';
      key: string;
      action: string;
      role?: 'normal' | 'primary' | 'destructive';
      label?: string;
    }
  /** The editor, switch or chooser of a declared field; at most one per field. */
  | { kind: 'input'; key: string; field: string; label?: string }
  | { kind: 'progress'; key: string; value: number; max: number; label?: string }
  | { kind: 'markdown'; key: string; text: string }
  | { kind: 'code'; key: string; text: string }
  /** A document-owned, paged semantic transcript; data stays outside the View. */
  | { kind: 'transcript'; key: string; resource: TranscriptResource }
  /** Where other plugins' views placed in slot `name` appear, given `context`. */
  | { kind: 'slot'; key: string; name: string; context?: Json };

export type TerminalControl =
  | { kind: 'toggle'; value: boolean }
  | {
      kind: 'text';
      value: string;
      max_bytes: number;
      multiline?: boolean;
      placeholder?: string;
      /** Drawn masked, for keys and passwords; never saved in shell checkpoints. */
      secret?: boolean;
    }
  | { kind: 'choice'; value: string; options: { value: string; label: string }[] };

export interface TerminalField {
  id: string;
  enabled?: boolean;
  control: TerminalControl;
}

export interface TerminalAction {
  id: string;
  label: string;
  enabled?: boolean;
  /** Only these fields are submitted. */
  fields?: string[];
  /** A read-only route that finds this submission's result after a lost reply. */
  recovery?: Json;
  /** The shell asks before submitting, in its own sheet. */
  confirm?: { title: string; message: string; destructive?: boolean };
}

export interface TerminalViewTree {
  version: 8;
  title: string;
  /** Opaque; echoed with every submission so writes can compare and swap. */
  revision: string;
  fields?: TerminalField[];
  actions?: TerminalAction[];
  root: TerminalNode;
}

export type TerminalRequest =
  | { kind: 'read'; route: Json; locale: string }
  | { kind: 'recover'; route: Json; locale: string }
  | {
      kind: 'submit';
      route: Json;
      revision: string;
      action: string;
      fields: Record<string, boolean | string>;
      grant: string | null;
      locale: string;
    };

export type TerminalReply =
  | { kind: 'view'; view: TerminalViewTree }
  | { kind: 'applied'; route: Json }
  /** Submit receipt: retain this document and reread the current route.
   * Confirms the action, not readback or a background operation's completion.
   * Recovery must return applied; a new document cannot restore transient state. */
  | { kind: 'updated' }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  /** No committed receipt was observed (recovery reads only). */
  | { kind: 'unrecorded' }
  /** An inert proposal; only the user's explicit approval in the shell grants it. */
  | { kind: 'consent'; request: AuthorizationRequest };

type Extra<T> = Partial<Omit<T, 'kind' | 'key'>>;
type ItemExtra = Extra<Extract<TerminalNode, { kind: 'item' }>>;

/** `ctx.tui`: terminal apps and the builders of their views. */
export interface TerminalApps extends TerminalBuilders {
  /** Serves a terminal app; the descriptor says where the shell shows it. */
  app<Model = Json>(
    name: string,
    definition: TerminalAppRegistration<Model>,
    descriptor: Omit<TerminalView, 'version'>,
    options?: import('./host.js').RemoteOptions,
  ): Promise<import('./host.js').Registration>;
  /** Registers a changes stream; call the result to refresh open views. */
  changes(name: string): Promise<(() => void) & { close(): Promise<void> }>;
  /** Registers a mount-scoped page/stream pair in the business activation. */
  transcriptResource(
    name: string,
    initial?: TranscriptInitial,
    options?: import('./host.js').RemoteOptions,
  ): Promise<TranscriptStore>;
}

/** Pure node and field builders; the only capability supplied to UI factories. */
export interface TerminalBuilders {
  collection(key: string, options: TerminalCollectionOptions): TerminalNode;
  view(body: TerminalViewBody): TerminalViewTree;
  column(key: string, children: TerminalNode[], gap?: number): TerminalNode;
  stack(key: string, children: TerminalNode[]): TerminalNode;
  row(key: string, children: TerminalNode[], gap?: number): TerminalNode;
  boundary(key: string, body: TerminalNode, options?: TerminalBoundaryOptions): TerminalNode;
  text(key: string, text: string, tone?: TerminalTone): TerminalNode;
  spans(key: string, spans: [string, TerminalTone?][]): TerminalNode;
  heading(key: string, text: string): TerminalNode;
  rule(key: string): TerminalNode;
  scroll(key: string, rows: number, child: TerminalNode): TerminalNode;
  split(key: string, ratio: number, left: TerminalNode, right: TerminalNode): TerminalNode;
  tabs(
    key: string,
    current: string,
    tabs: { id: string; label: string; route: Json }[],
  ): TerminalNode;
  link(key: string, title: string, route: Json, extra?: ItemExtra): TerminalNode;
  act(key: string, title: string, action: string, extra?: ItemExtra): TerminalNode;
  open(key: string, title: string, session: string, extra?: ItemExtra): TerminalNode;
  button(
    key: string,
    action: string,
    role?: 'normal' | 'primary' | 'destructive',
    label?: string,
  ): TerminalNode;
  input(key: string, field: string, label?: string): TerminalNode;
  progress(key: string, value: number, max: number, label?: string): TerminalNode;
  markdown(key: string, text: string): TerminalNode;
  code(key: string, text: string): TerminalNode;
  transcript(key: string, resource: TranscriptResource): TerminalNode;
  slot(key: string, name: string, context?: Json): TerminalNode;
  action(id: string, label: string, extra?: Partial<TerminalAction>): TerminalAction;
  toggle(id: string, value: boolean): TerminalField;
  line(
    id: string,
    value?: string,
    maxBytes?: number,
    extra?: { placeholder?: string; secret?: boolean },
  ): TerminalField;
  area(
    id: string,
    value?: string,
    maxBytes?: number,
    extra?: { placeholder?: string },
  ): TerminalField;
  choice(id: string, value: string, options: [string, string][]): TerminalField;
}

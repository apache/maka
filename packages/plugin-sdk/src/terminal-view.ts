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
  version: 4;
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

export type TerminalTarget =
  /** Read another route of this view; Back returns. */
  | { kind: 'route'; route: Json }
  /** Submit a declared action. */
  | { kind: 'action'; action: string };

/** Keys are unique among siblings, contain no `/`, and stay stable across reads. */
export type TerminalNode =
  | { kind: 'column'; key: string; gap?: number; children: TerminalNode[] }
  | { kind: 'row'; key: string; gap?: number; children: TerminalNode[] }
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
  version: 4;
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
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  /** No committed receipt was observed (recovery reads only). */
  | { kind: 'unrecorded' }
  /** An inert proposal; only the user's explicit approval in the shell grants it. */
  | { kind: 'consent'; request: AuthorizationRequest };

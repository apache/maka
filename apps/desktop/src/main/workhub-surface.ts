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

import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

export const ASSISTANT_EXCLUDED =
  '[data-maka-assistant-exclude],.desktopAssistant,.desktopAssistantCursor,.desktopAssistantLauncher,.maka-browser-panel,.maka-session-terminal-panel,.xterm,iframe,webview,input[type="password"],input[type="file"]';
const marker = "data-maka-assistant-ref";
const sensitiveField =
  /password|secret|api.?key|access.?token|private.?key|密码|密碼|密钥|金鑰|令牌/i;

interface Control {
  ref: string;
  name: string;
  role: string;
  section: string;
  external: boolean;
  editable: boolean;
  backendNodeId?: number;
}

/** Opaque handles bind actions to this observation's actual DOM nodes. */
export class WorkHubSurface {
  private controls = new Map<string, Control>();
  private rootIds = new Set<number>();

  async prepare(wc: WebContents) {
    const prefix = randomUUID().slice(0, 8);
    const controls: Control[] = await wc.executeJavaScript(`(() => {
      const excluded = ${JSON.stringify(ASSISTANT_EXCLUDED)};
      const privateField = ${sensitiveField.toString()};
      for (const e of document.querySelectorAll('[${marker}]')) e.removeAttribute('${marker}');
      const result = [];
      const candidates = document.querySelectorAll('button,a,input,textarea,select,[role],[contenteditable="true"],h1,h2,h3,h4,p,label');
      for (const e of candidates) {
        if (e.closest(excluded) || e.closest('[hidden],[inert],[aria-hidden="true"]') || e.matches(':disabled,[aria-disabled="true"]')) continue;
        const r = e.getBoundingClientRect(), style = getComputedStyle(e);
        if (r.width <= 1 || r.height <= 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || style.visibility === 'hidden' || style.opacity === '0') continue;
        const label = e.getAttribute('aria-label') || e.labels?.[0]?.textContent || e.getAttribute('placeholder') || e.getAttribute('title') || '';
        if (e.matches('input,textarea,[contenteditable]') && privateField.test(label + ' ' + (e.getAttribute('name') || '') + ' ' + (e.getAttribute('autocomplete') || ''))) continue;
        const ref = ${JSON.stringify(prefix)} + '-' + result.length;
        e.setAttribute('${marker}', ref);
        const href = e.getAttribute('href');
        result.push({ ref, name: label.trim().slice(0, 240), role: '',
          section: e.closest('[data-maka-assistant-section]')?.getAttribute('data-maka-assistant-section') || '',
          external: !!href && !href.startsWith('#') && !href.startsWith('maka://'),
          editable: e.matches('input:not([readonly]),textarea:not([readonly]),[contenteditable="true"]') });
      }
      return result;
    })()`);
    this.controls = new Map(controls.map((control) => [control.ref, control]));
    this.rootIds.clear();
  }

  filter(root: DomNode, tree: { nodes: AxNode[] }) {
    const allowed = new Set<number>();
    const byBackend = new Map<number, Control>();
    const visit = (node: DomNode, inherited = false, blocked = false) => {
      const attrs = Object.fromEntries(
        Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, i) => [
          node.attributes![2 * i]!,
          node.attributes![2 * i + 1]!,
        ]),
      );
      blocked ||=
        ["IFRAME", "WEBVIEW"].includes(node.nodeName) ||
        "data-maka-assistant-exclude" in attrs ||
        /(?:^|\s)(?:desktopAssistant\S*|maka-browser-panel|maka-session-terminal-panel|xterm)(?:\s|$)/.test(
          attrs.class ?? "",
        ) ||
        ["password", "file"].includes(attrs.type ?? "");
      const control = this.controls.get(attrs[marker] ?? "");
      const safe = !blocked && (inherited || !!control);
      // Unmarked editors may contain a revealed credential. Exclude them even
      // when their surrounding visible label/region is observed.
      const unmarkedEditor =
        ["INPUT", "TEXTAREA"].includes(node.nodeName) && !control;
      if (safe && !unmarkedEditor) allowed.add(node.backendNodeId);
      if (control && !blocked) {
        control.backendNodeId = node.backendNodeId;
        byBackend.set(node.backendNodeId, control);
      }
      for (const child of node.children ?? [])
        visit(child, safe && !unmarkedEditor, blocked || unmarkedEditor);
    };
    visit(root);
    const nodes = tree.nodes
      .filter(
        (node) => !node.ignored && allowed.has(node.backendDOMNodeId ?? -1),
      )
      .map((node) => {
        const control = byBackend.get(node.backendDOMNodeId ?? -1);
        if (control) {
          control.name = String(node.name?.value ?? control.name).slice(0, 240);
          control.role = String(node.role?.value ?? "");
        }
        return ["generic", "group"].includes(String(node.role?.value))
          ? { ...node, name: { value: "" } }
          : node;
      });
    const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
    this.rootIds = allowed;
    return {
      nodes: [
        {
          nodeId: "maka-app-root",
          role: { value: "RootWebArea" },
          name: { value: "Maka application" },
          childIds: nodes
            .filter((node) => !children.has(node.nodeId))
            .map((node) => node.nodeId),
        },
        ...nodes,
      ],
    };
  }

  list() {
    return [...this.controls.values()]
      .filter(
        (control) =>
          control.role &&
          control.backendNodeId &&
          this.rootIds.has(control.backendNodeId),
      )
      .map(({ ref, name, role, editable }) => ({ ref, name, role, editable }));
  }

  async resolve(wc: WebContents, ref: string, operation: string) {
    const control = this.controls.get(ref);
    if (!control?.backendNodeId || !control.role)
      throw new Error("Stale control reference; observe the interface again");
    if (control.external)
      throw new Error("External browser links are outside the assistant scope");
    if (
      operation === "click" &&
      ![
        "button",
        "link",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "textbox",
        "searchbox",
        "combobox",
        "option",
        "tab",
        "checkbox",
        "radio",
        "switch",
        "slider",
        "spinbutton",
        "treeitem",
      ].includes(control.role)
    )
      throw new Error(
        "Choose the actual interactive control, not its surrounding content",
      );
    if (
      operation === "key" &&
      !control.editable &&
      !["combobox", "listbox", "option"].includes(control.role)
    )
      throw new Error("Keyboard input requires an editor or selection control");
    const css = `[${marker}=${JSON.stringify(ref)}]`;
    const allowed = await wc.executeJavaScript(`(() => {
      const e = document.querySelector(${JSON.stringify(css)});
      return !!e && !e.closest(${JSON.stringify(ASSISTANT_EXCLUDED)}) && !e.closest('[inert],[hidden],[aria-hidden="true"]') && !e.matches(':disabled,[aria-disabled="true"]')
        && (e.closest('[data-maka-assistant-section]')?.getAttribute('data-maka-assistant-section') || '') === ${JSON.stringify(control.section)}
        && (${operation === "type" ? "!e.matches('[readonly]')" : "true"});
    })()`);
    if (!allowed)
      throw new Error(
        "The control is unavailable or outside the assistant scope",
      );
    const { root } = await wc.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: css,
    });
    if (!nodeId) throw new Error("The control was removed; observe again");
    const { node } = await wc.debugger.sendCommand("DOM.describeNode", {
      nodeId,
    });
    if (node.backendNodeId !== control.backendNodeId)
      throw new Error("The control was replaced; observe again");
    const { nodes } = await wc.debugger.sendCommand(
      "Accessibility.getPartialAXTree",
      { backendNodeId: control.backendNodeId, fetchRelatives: false },
    );
    const current = nodes.find(
      (node: AxNode) => node.backendDOMNodeId === control.backendNodeId,
    );
    if (
      !current ||
      current.ignored ||
      String(current.name?.value ?? "").slice(0, 240) !== control.name ||
      current.role?.value !== control.role
    )
      throw new Error("The control changed since observation; action stopped");
    if (operation === "type" && !control.editable)
      throw new Error("This control is not an editable field");
    return { css, name: control.name, role: control.role };
  }
}

interface DomNode {
  nodeName: string;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
}
interface AxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  childIds?: string[];
  name?: { value?: unknown };
  role?: { value?: unknown };
}

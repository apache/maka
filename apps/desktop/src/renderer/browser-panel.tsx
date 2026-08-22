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
 * BrowserPanel (P3) — the renderer half of the embedded browser's right-side
 * panel.
 *
 * The browser itself is a native Electron WebContentsView that floats ABOVE the
 * renderer DOM (not a React child), so this component does not render the page.
 * It draws the chrome (address bar + nav controls) and reserves a strip, then
 * mirrors that strip's on-screen rect to main, which positions the native view
 * to match. When the strip is hidden (a modal is open), the panel unmounts, or
 * no page is loaded yet, it hands main a null rect so the native layer hides and
 * either a centered dialog or the DOM empty state shows through.
 *
 * It mounts only for sessions with a live view (see browser:live), so an
 * ordinary chat reserves no space.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ICON_SIZE, ChevronLeft, ChevronRight, Globe, RotateCw, X } from '@maka/ui/icons';
import { normalizeBrowserAddressInput, type BrowserState } from '@maka/core/browser';
import {
  IconButton,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { getBrowserCopy, type BrowserCopy } from './locales/browser-copy';

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  secure: false,
  hasPage: false,
};

function browserAddressFailureCopy(reason: 'unsupported_scheme' | 'invalid_url', copy: BrowserCopy): string {
  switch (reason) {
    case 'unsupported_scheme':
      return copy.unsupportedScheme;
    case 'invalid_url':
      return copy.invalidUrl;
  }
}

export function BrowserPanel(props: { sessionId: string; hidden: boolean }) {
  const { sessionId, hidden } = props;
  const toast = useToast();
  const copy = getBrowserCopy(useUiLocale());
  const stripRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);
  // The address input is editable; it only snaps to the live URL when the user
  // is not mid-edit (tracked by focus) so typing is never clobbered by a
  // did-navigate state push.
  const [address, setAddress] = useState('');
  const editingRef = useRef(false);
  const browserPanelMountedRef = useMountedRef();
  const browserPanelSessionIdRef = useRef(sessionId);

  browserPanelSessionIdRef.current = sessionId;

  const isBrowserPanelSessionCurrent = useCallback((ownerSessionId: string): boolean => {
    return browserPanelMountedRef.current && browserPanelSessionIdRef.current === ownerSessionId;
  }, []);

  // Subscribe to this session's state pushes + seed the initial state.
  useEffect(() => {
    let alive = true;
    editingRef.current = false;
    setState(EMPTY_STATE);
    setAddress('');
    const apply = (next: BrowserState) => {
      if (!alive) return;
      setState(next);
      if (!editingRef.current) setAddress(next.url);
    };
    void window.maka.browser
      .getState(sessionId)
      .then((s) => apply(s ?? EMPTY_STATE))
      .catch(() => apply(EMPTY_STATE));
    const off = window.maka.browser.onState((payload) => {
      if (payload.sessionId === sessionId) apply(payload.state);
    });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);

  // Mirror the strip's on-screen rect to main every animation frame while it is
  // showable. Position shifts on window resize and sidebar drags even when the
  // size is unchanged, which a ResizeObserver would miss; a getBoundingClientRect
  // per frame is negligible and the IPC only fires when the rect changes.
  const showView = !hidden && state.hasPage;
  useEffect(() => {
    // Captured because this passive cleanup can run after a bridge host
    // (Storybook's scoped decorator) has already torn `window.maka` down.
    const { browser } = window.maka;
    if (!showView) {
      browser.setViewport({ sessionId, rect: null });
      return;
    }
    const el = stripRef.current;
    if (!el) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const r = el.getBoundingClientRect();
      const rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (key !== last) {
        last = key;
        browser.setViewport({ sessionId, rect });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      browser.setViewport({ sessionId, rect: null });
    };
  }, [sessionId, showView]);

  const go = useCallback(() => {
    const result = normalizeBrowserAddressInput(address);
    if (!result.ok) {
      if (result.reason !== 'empty') {
        toast.error(copy.openFailed, browserAddressFailureCopy(result.reason, copy));
      }
      return;
    }
    const ownerSessionId = sessionId;
    void window.maka.browser.navigate(ownerSessionId, result.url).catch(() => {
      if (isBrowserPanelSessionCurrent(ownerSessionId)) {
        toast.error(
          copy.navigationFailed,
          copy.navigationFailedDetail,
          undefined,
          { sessionId: ownerSessionId },
        );
      }
    });
  }, [address, copy, isBrowserPanelSessionCurrent, sessionId, toast]);

  return (
    <div
      className="maka-browser-panel"
      role="region"
      aria-label={state.title ? copy.panelAriaWithTitle(state.title) : copy.panelAria}
    >
      <Toolbar
        className="maka-browser-toolbar"
        label={copy.panelAria}
        size="sm"
        startContent={(
          <>
            <Tooltip content={copy.back}>
              <IconButton
                label={copy.backAria}
                icon={<ChevronLeft size={ICON_SIZE.chrome} aria-hidden />}
                variant="ghost"
                size="sm"
                isDisabled={!state.canGoBack}
                onClick={() => void window.maka.browser.back(sessionId)}
              />
            </Tooltip>
            <Tooltip content={copy.forward}>
              <IconButton
                label={copy.forwardAria}
                icon={<ChevronRight size={ICON_SIZE.chrome} aria-hidden />}
                variant="ghost"
                size="sm"
                isDisabled={!state.canGoForward}
                onClick={() => void window.maka.browser.forward(sessionId)}
              />
            </Tooltip>
            <Tooltip content={state.loading ? copy.stop : copy.refresh}>
              <IconButton
                label={state.loading ? copy.stopAria : copy.refreshAria}
                icon={state.loading ? <X size={ICON_SIZE.chrome} aria-hidden /> : <RotateCw size={ICON_SIZE.chrome} aria-hidden />}
                variant="ghost"
                size="sm"
                isDisabled={!state.hasPage && !state.loading}
                onClick={() =>
                  state.loading ? void window.maka.browser.stop(sessionId) : void window.maka.browser.reload(sessionId)
                }
              />
            </Tooltip>
            <div className="maka-browser-address-field">
              <TextInput
                type="text"
                label={copy.addressAria}
                isLabelHidden
                width="100%"
                placeholder={copy.addressPlaceholder}
                status={state.hasPage && !state.secure ? { type: 'warning', message: copy.insecure } : undefined}
                statusVariant="tooltip"
                value={address}
                onChange={setAddress}
                onFocus={() => {
                  editingRef.current = true;
                }}
                onBlur={() => {
                  editingRef.current = false;
                  setAddress(state.url);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                    go();
                  }
                }}
              />
            </div>
          </>
        )}
        endContent={(
          <Tooltip content={copy.close}>
            <IconButton
              label={copy.closeAria}
              icon={<X size={ICON_SIZE.chrome} aria-hidden />}
              variant="ghost"
              size="sm"
              onClick={() => void window.maka.browser.close(sessionId)}
            />
          </Tooltip>
        )}
      />
      <div className="maka-browser-strip" ref={stripRef}>
        {!state.hasPage && (
          <EmptyState
            icon={<Globe size={ICON_SIZE.empty} aria-hidden="true" />}
            title={copy.title}
            description={copy.description}
          />
        )}
      </div>
    </div>
  );
}

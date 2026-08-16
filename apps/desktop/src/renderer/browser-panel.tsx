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
import { ICON_SIZE, ChevronLeft, ChevronRight, Globe, Plus, RotateCw, Save, Workflow, X } from '@maka/ui/icons';
import { normalizeBrowserAddressInput, type BrowserState } from '@maka/core/browser';
import type {
  BrowserWorkflowAction,
  BrowserWorkflowProgress,
} from '@maka/core/browser-workflow';
import {
  IconButton,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { getBrowserCopy, type BrowserCopy } from './locales/browser-copy';
import { useBrowserWorkflowSessionLifecycle } from './use-browser-workflow-session-lifecycle';

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  favicon: null,
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
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    draftId: string;
    actionCount: number;
    sensitiveActionIds: string[];
    actions: BrowserWorkflowAction[];
  } | null>(null);
  const [draftName, setDraftName] = useState(copy.defaultWorkflowName);
  const [waitKind, setWaitKind] = useState<'selector' | 'text'>('selector');
  const [waitValue, setWaitValue] = useState('');
  const [workflowProgress, setWorkflowProgress] = useState<BrowserWorkflowProgress | null>(null);
  const isWorkflowSessionCurrent = useBrowserWorkflowSessionLifecycle(sessionId);
  const editingRef = useRef(false);
  const browserPanelMountedRef = useMountedRef();
  const browserPanelSessionIdRef = useRef(sessionId);

  browserPanelSessionIdRef.current = sessionId;

  const isBrowserPanelSessionCurrent = useCallback((ownerSessionId: string): boolean => {
    return browserPanelMountedRef.current && browserPanelSessionIdRef.current === ownerSessionId;
  }, []);

  useEffect(() => {
    setRecordingId(null);
    setDraft(null);
    setDraftName(copy.defaultWorkflowName);
    setWaitKind('selector');
    setWaitValue('');
    setWorkflowProgress(null);
  }, [copy.defaultWorkflowName, sessionId]);

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

  useEffect(() => {
    const off = window.maka.browser.workflows.onProgress((payload) => {
      if (payload.sessionId !== sessionId) return;
      if (payload.workflowId === 'recording' && payload.status === 'canceled') setRecordingId(null);
      setWorkflowProgress(payload);
    });
    return off;
  }, [sessionId]);

  const startRecording = useCallback(() => {
    const ownerSessionId = sessionId;
    void window.maka.browser.workflows.startRecording(sessionId)
      .then((handle) => {
        if (!isWorkflowSessionCurrent(ownerSessionId)) return;
        setRecordingId(handle.recordingId);
        setDraft(null);
      })
      .catch(() => {
        if (isWorkflowSessionCurrent(ownerSessionId)) {
          toast.error(copy.startRecording, copy.navigationFailedDetail);
        }
      });
  }, [copy.navigationFailedDetail, copy.startRecording, isWorkflowSessionCurrent, sessionId, toast]);

  const stopRecording = useCallback(() => {
    const ownerSessionId = sessionId;
    void window.maka.browser.workflows.stopRecording(sessionId)
      .then((result) => {
        if (!isWorkflowSessionCurrent(ownerSessionId)) return;
        setRecordingId(null);
        setDraft(result);
        setDraftName(copy.defaultWorkflowName);
      })
      .catch((error: unknown) => {
        if (!isWorkflowSessionCurrent(ownerSessionId)) return;
        setRecordingId(null);
        toast.error(copy.stopRecording, error instanceof Error ? error.message : String(error));
      });
  }, [copy.defaultWorkflowName, copy.stopRecording, isWorkflowSessionCurrent, sessionId, toast]);

  const saveRecording = useCallback(() => {
    if (!draft) return;
    const ownerSessionId = sessionId;
    void window.maka.browser.workflows.saveRecording(draft.draftId, draftName)
      .then(() => {
        if (!isWorkflowSessionCurrent(ownerSessionId)) return;
        setDraft(null);
        toast.success(copy.recordingSaved);
      })
      .catch((error: unknown) => {
        if (isWorkflowSessionCurrent(ownerSessionId)) {
          toast.error(copy.saveRecording, error instanceof Error ? error.message : String(error));
        }
      });
  }, [copy.recordingSaved, copy.saveRecording, draft, draftName, isWorkflowSessionCurrent, sessionId, toast]);

  const discardRecording = useCallback(() => {
    if (!draft) return;
    window.maka.browser.workflows.discardRecording(draft.draftId);
    setDraft(null);
  }, [draft]);

  const addWaitCondition = useCallback(() => {
    const value = waitValue.trim();
    if (!recordingId || !value) return;
    const ownerSessionId = sessionId;
    void window.maka.browser.workflows
      .addWaitCondition(sessionId, { kind: waitKind, value, timeoutMs: 15_000 })
      .then(() => {
        if (isWorkflowSessionCurrent(ownerSessionId)) setWaitValue('');
      })
      .catch((error: unknown) => {
        if (isWorkflowSessionCurrent(ownerSessionId)) {
          toast.error(copy.recordWaitCondition, error instanceof Error ? error.message : String(error));
        }
      });
  }, [copy.recordWaitCondition, isWorkflowSessionCurrent, recordingId, sessionId, toast, waitKind, waitValue]);

  // Mirror the strip's on-screen rect to main every animation frame while it is
  // showable. Position shifts on window resize and sidebar drags even when the
  // size is unchanged, which a ResizeObserver would miss; a getBoundingClientRect
  // per frame is negligible and the IPC only fires when the rect changes.
  const showView = !hidden && state.hasPage;
  useEffect(() => {
    if (!showView) {
      window.maka.browser.setViewport({ sessionId, rect: null });
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
        window.maka.browser.setViewport({ sessionId, rect });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.maka.browser.setViewport({ sessionId, rect: null });
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
        toast.error(copy.navigationFailed, copy.navigationFailedDetail);
      }
    });
  }, [address, copy, isBrowserPanelSessionCurrent, sessionId, toast]);

  return (
    <div className="maka-browser-panel" role="region" aria-label={copy.panelAria}>
      <Toolbar
        className="maka-browser-toolbar"
        label={copy.panelAria}
        size="sm"
        startContent={(
          <div className="maka-browser-toolbar-start">
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
          </div>
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
      <div className="maka-browser-workflow-controls" role="group" aria-label={copy.startRecording}>
        <Tooltip content={recordingId ? copy.stopRecording : copy.startRecording}>
          <IconButton
            label={recordingId ? copy.stopRecordingAria : copy.startRecordingAria}
            icon={
              recordingId ? <X size={ICON_SIZE.chrome} aria-hidden /> : <Workflow size={ICON_SIZE.chrome} aria-hidden />
            }
            variant={recordingId ? 'primary' : 'ghost'}
            size="sm"
            isDisabled={!state.hasPage && !recordingId}
            onClick={recordingId ? stopRecording : startRecording}
          />
        </Tooltip>
        {draft && (
          <>
            <div className="maka-browser-workflow-name-field">
              <TextInput
                type="text"
                label={copy.recordingName}
                isLabelHidden
                width="100%"
                value={draftName}
                onChange={setDraftName}
                placeholder={copy.recordingName}
              />
            </div>
            <Tooltip content={copy.saveRecording}>
              <IconButton
                label={copy.saveRecordingAria}
                icon={<Save size={ICON_SIZE.chrome} aria-hidden />}
                variant="ghost"
                size="sm"
                isDisabled={!draftName.trim()}
                onClick={saveRecording}
              />
            </Tooltip>
            <Tooltip content={copy.discardRecording}>
              <IconButton
                label={copy.discardRecordingAria}
                icon={<X size={ICON_SIZE.chrome} aria-hidden />}
                variant="ghost"
                size="sm"
                onClick={discardRecording}
              />
            </Tooltip>
          </>
        )}
        {workflowProgress && workflowProgress.status === 'running' && (
          <>
            <span className="maka-browser-workflow-progress" role="status">
              {copy.recordingProgress(workflowProgress.current, workflowProgress.total)}
            </span>
            {workflowProgress.total > 0 && (
              <Tooltip content={copy.cancelReplay}>
                <IconButton
                  label={copy.cancelReplay}
                  icon={<X size={ICON_SIZE.chrome} aria-hidden />}
                  variant="ghost"
                  size="sm"
                  onClick={() => window.maka.browser.workflows.cancel(workflowProgress.runId)}
                />
              </Tooltip>
            )}
          </>
        )}
      </div>
      {recordingId && (
        <div className="maka-browser-workflow-wait-editor" role="group" aria-label={copy.waitConditionGroup}>
          <SegmentedControl
            value={waitKind}
            onChange={(value) => setWaitKind(value as 'selector' | 'text')}
            label={copy.waitConditionGroup}
            size="sm"
          >
            <SegmentedControlItem value="selector" label={copy.waitSelectorMode} />
            <SegmentedControlItem value="text" label={copy.waitTextMode} />
          </SegmentedControl>
          <TextInput
            type="text"
            label={waitKind === 'selector' ? copy.waitSelectorLabel : copy.waitTextLabel}
            isLabelHidden
            width="100%"
            value={waitValue}
            onChange={setWaitValue}
          />
          <Tooltip content={copy.recordWaitCondition}>
            <IconButton
              label={copy.recordWaitConditionAria}
              icon={<Plus size={ICON_SIZE.chrome} aria-hidden />}
              variant="ghost"
              size="sm"
              isDisabled={!waitValue.trim()}
              onClick={addWaitCondition}
            />
          </Tooltip>
        </div>
      )}
      {draft && (
        <div className="maka-browser-workflow-review" role="group" aria-label={copy.reviewRecording}>
          <span className="maka-browser-workflow-review-title">{copy.reviewRecording}</span>
          <ol>
            {draft.actions.map((action) => (
              <li key={action.id}>
                <span>{workflowActionLabel(action, copy)}</span>
                <code>{workflowActionDetail(action)}</code>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="maka-browser-strip" ref={stripRef}>
        {!state.hasPage && (
          <EmptyState
            className="maka-browser-empty"
            icon={<Globe size={ICON_SIZE.empty} aria-hidden="true" />}
            title={copy.title}
            description={copy.description}
            isCompact
          />
        )}
      </div>
    </div>
  );
}

function workflowActionLabel(
  action: BrowserWorkflowAction,
  copy: BrowserCopy,
): string {
  switch (action.kind) {
    case 'navigate':
      return copy.actionNavigate;
    case 'click':
      return copy.actionClick;
    case 'check':
      return action.checked ? copy.actionCheck : copy.actionUncheck;
    case 'type':
      return action.sensitive ? copy.actionSensitiveType : copy.actionType;
    case 'wait':
      return action.url || action.navigation
        ? copy.actionWaitNavigation
        : action.selector
          ? copy.actionWaitSelector
          : copy.actionWaitText;
  }
}

function workflowActionDetail(action: BrowserWorkflowAction): string {
  switch (action.kind) {
    case 'navigate':
      return action.url;
    case 'click':
    case 'type':
      return `${action.locator.kind}: ${action.locator.value}`;
    case 'check':
      return `${action.locator.kind}: ${action.locator.value}`;
    case 'wait':
      return action.url ?? action.selector ?? action.text ?? '';
  }
}

import type { SandboxBoundaryRequestEvent } from '@maka/core/events';
import { useEffect, useId, useRef, useState } from 'react';

import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';
import { Button } from '@astryxdesign/core';
import { useMountedRef } from './use-mounted-ref.js';

export interface SandboxBoundaryPromptProps {
  request: SandboxBoundaryRequestEvent;
  onRespond(response: { requestId: string; decision: 'allow' | 'deny' }): void | Promise<void>;
}

export function SandboxBoundaryPrompt({
  request,
  onRespond,
}: SandboxBoundaryPromptProps) {
  const copy = getConversationCopy(useUiLocale()).sandboxBoundary;
  const titleId = useId();
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(request.requestId);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = request.requestId;
    responsePendingRef.current = false;
    setResponsePending(false);
    const frame = window.requestAnimationFrame(() => rejectButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [request.requestId]);

  async function respond(decision: 'allow' | 'deny'): Promise<void> {
    if (responsePendingRef.current) return;
    const requestId = request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await onRespond({ requestId, decision });
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  const entries = request.expansion.filesystem?.entries ?? [];
  return (
    <section
      className="maka-composer-interaction maka-sandbox-boundary-prompt composer"
      aria-labelledby={titleId}
    >
      <div className="maka-composer-interaction-inner maka-sandbox-boundary-prompt-inner">
        <div className="maka-sandbox-boundary-copy">
          <h2 id={titleId}>{copy.title}</h2>
          <p>{request.justification}</p>
        </div>
        <ul className="maka-sandbox-boundary-scopes">
          {entries.map((entry) => (
            <li key={`${entry.access}:${entry.scope}:${entry.path}`}>
              <code>{entry.path}</code>
              <span>
                {copy.access[entry.access]} · {copy.scope[entry.scope]}
              </span>
            </li>
          ))}
          {request.expansion.network?.enabled ? (
            <li>
              <code>{copy.network}</code>
              <span>{copy.enabled}</span>
            </li>
          ) : null}
        </ul>
        <div className="maka-sandbox-boundary-actions">
          <Button
            ref={rejectButtonRef}
            variant="secondary"
            isDisabled={responsePending}
            onClick={() => void respond('deny')}
            label={copy.reject}
          />
          <Button
            variant="primary"
            isDisabled={responsePending}
            onClick={() => void respond('allow')}
            label={copy.allowSession}
          />
        </div>
      </div>
    </section>
  );
}

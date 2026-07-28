import type { SandboxBoundaryRequestEvent } from '@maka/core';
import { useEffect, useRef, useState } from 'react';

import { Button } from './ui.js';

export interface SandboxBoundaryPromptProps {
  request: SandboxBoundaryRequestEvent;
  onRespond(response: { requestId: string; decision: 'allow' | 'deny' }): void | Promise<void>;
}

export function SandboxBoundaryPrompt({
  request,
  onRespond,
}: SandboxBoundaryPromptProps) {
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    responsePendingRef.current = false;
    setResponsePending(false);
    const frame = window.requestAnimationFrame(() => rejectButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [request.requestId]);

  async function respond(decision: 'allow' | 'deny'): Promise<void> {
    if (responsePendingRef.current) return;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await onRespond({ requestId: request.requestId, decision });
    } finally {
      responsePendingRef.current = false;
      setResponsePending(false);
    }
  }

  const entries = request.expansion.filesystem?.entries ?? [];
  return (
    <section
      className="maka-composer-interaction maka-sandbox-boundary-prompt composer"
      aria-labelledby="sandboxBoundaryTitle"
    >
      <div className="maka-composer-interaction-inner maka-sandbox-boundary-prompt-inner">
        <div className="maka-sandbox-boundary-copy">
          <h2 id="sandboxBoundaryTitle">Expand sandbox boundary?</h2>
          <p>{request.justification}</p>
        </div>
        <ul className="maka-sandbox-boundary-scopes">
          {entries.map((entry) => (
            <li key={`${entry.access}:${entry.scope}:${entry.path}`}>
              <code>{entry.path}</code>
              <span>
                {entry.access} · {entry.scope}
              </span>
            </li>
          ))}
          {request.expansion.network?.enabled ? (
            <li>
              <code>Network access</code>
              <span>enabled</span>
            </li>
          ) : null}
        </ul>
        <div className="maka-sandbox-boundary-actions">
          <Button
            ref={rejectButtonRef}
            variant="secondary"
            disabled={responsePending}
            onClick={() => void respond('deny')}
          >
            Reject
          </Button>
          <Button disabled={responsePending} onClick={() => void respond('allow')}>
            Allow for this session
          </Button>
        </div>
      </div>
    </section>
  );
}

/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { cleanup, signal, host as surfaceHost } from 'nsh';
import { host } from 'maka/host';
import type { Output } from '../../../../products/maka/workbench/app/host';
type AgentBotOutbox = Output<'agent', 'botOutbox'>;

/** One durable Host-owned outbox shared by the main window and the quick panel. */
export function createAssistantInbox(report: (error: unknown) => void) {
  const sessionId = signal<string | null>(null),
    unread = signal(0),
    preview = signal('');
  if (surfaceHost.params.quickToolsPanel !== true) return { sessionId, unread, preview };
  let alive = true;
  let outbox: { next(): Promise<unknown>; close(): Promise<void> } | undefined;
  cleanup(() => {
    alive = false;
    void outbox?.close().catch(() => {});
  });
  void (async () => {
    const stream = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
    if (!alive) {
      await stream.close();
      return;
    }
    outbox = stream;
    for (;;) {
      const head = (await stream.next()) as AgentBotOutbox | null;
      if (!alive || !head) return;
      sessionId.set(head.sessionId ?? null);
      unread.set(head.isBot ? Math.max(0, head.through - head.readThrough) : 0);
      preview.set(head.preview);
    }
  })().catch((error) => {
    if (alive) report(error);
  });
  return { sessionId, unread, preview };
}

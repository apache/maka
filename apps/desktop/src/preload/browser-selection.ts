import type { BrowserViewRect } from '@maka/core/browser';

export interface ResolvedBrowserSession {
  readonly scope: unknown;
  readonly sessionId: string;
}

interface BrowserSelectionSink {
  show(documentId: string, generation: number, session: ResolvedBrowserSession): void;
  hide(documentId: string, generation: number): void;
  setViewport(
    documentId: string,
    generation: number,
    session: ResolvedBrowserSession,
    rect: BrowserViewRect | null,
  ): void;
}

/**
 * Orders native browser visibility around the renderer's current selection.
 * Session ownership resolution may finish out of order, so every async result
 * must still belong to the selection generation that started it before it can
 * reach main.
 */
export function createBrowserSelectionCoordinator(
  resolveSession: (sessionId: string) => Promise<ResolvedBrowserSession>,
  sink: BrowserSelectionSink,
  documentId: string = crypto.randomUUID(),
) {
  let generation = 0;
  let current:
    | {
        readonly generation: number;
        readonly sessionId: string;
        readonly resolved: Promise<ResolvedBrowserSession>;
      }
    | undefined;

  const isCurrent = (selection: NonNullable<typeof current>): boolean =>
    current === selection;

  return {
    setActiveSession(sessionId: string | null): void {
      generation += 1;
      if (!sessionId) {
        current = undefined;
        sink.hide(documentId, generation);
        return;
      }

      const selection = {
        generation,
        sessionId,
        resolved: resolveSession(sessionId),
      };
      current = selection;
      void selection.resolved.then(
        (session) => {
          if (isCurrent(selection)) sink.show(documentId, selection.generation, session);
        },
        () => {
          if (isCurrent(selection)) sink.hide(documentId, selection.generation);
        },
      );
    },

    setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void {
      const selection = current;
      if (!selection || selection.sessionId !== input.sessionId) return;
      void selection.resolved.then(
        (session) => {
          if (isCurrent(selection)) {
            sink.setViewport(documentId, selection.generation, session, input.rect);
          }
        },
        () => undefined,
      );
    },
  };
}

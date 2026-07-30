import { useRef } from 'react';
import {
  ChatView,
  Composer,
  SandboxBoundaryPrompt,
  UserQuestionPrompt,
  useUiLocale,
  type ChatModelChoice,
  type ComposerHandle,
} from '@maka/ui';
import type { SessionSummary } from '@maka/core';
import { useQuoteCompanion } from './use-quote-companion';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  StagedCompanionQuote,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

/**
 * The "追问引用" workbar tab: a follow-up thread about the selected excerpt(s).
 * It renders with the SAME surface as the main conversation — the real
 * `ChatView` transcript (markdown, tool activity, token streaming) and the real
 * `Composer` — bound to a read-only companion fork of the main session (see
 * useQuoteCompanion). The fork KNOWS the main conversation's context and inherits
 * its model (shown read-only — no independent picker). It explains and explores;
 * writes/shell are blocked, and web/custom tools prompt here. Selecting more text
 * in the main transcript adds another quote chip to THIS thread.
 */
export function QuoteCompanionPanel(props: {
  panelId: string;
  /** Excerpts staged for the next send (accumulated as the user adds more). */
  quotes: readonly StagedCompanionQuote[];
  sourceSession: SessionSummary | undefined;
  /** Shared global choice list, only used to render the inherited model's label. */
  modelChoices: readonly ChatModelChoice[];
  onClear?: () => void;
  onQuotesConsumed: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).quoteCompanion;
  const composerRef = useRef<ComposerHandle>(null);
  const companion = useQuoteCompanion({
    panelId: props.panelId,
    pendingQuotes: props.quotes,
    sourceSession: props.sourceSession,
    locale,
    onQuotesConsumed: props.onQuotesConsumed,
    onForkVisibilityChange: props.onForkVisibilityChange,
  });

  // The companion inherits the source model and does not switch it; look up a
  // friendly label from the shared choice list purely for a read-only display.
  const activeModel = companion.activeModel;
  const activeModelLabel =
    (activeModel
      ? props.modelChoices.find(
          (choice) =>
            choice.connectionSlug === activeModel.llmConnectionSlug &&
            choice.model === activeModel.model,
        )?.label
      : undefined) ?? activeModel?.model;

  const activeInteraction = companion.activeSandboxBoundary ?? companion.activeQuestion;

  return (
    <div className="maka-quote-companion">
      <ChatView
        messages={companion.messages}
        liveTurn={companion.liveTurn}
        processingIndicator={companion.processing}
        activeSession={companion.companionSession}
        emptyOverride={
          <div className="maka-quote-companion-intro">
            {props.quotes.map((quote) => (
              <blockquote key={quote.id} className="maka-quote-panel-quote">
                {quote.value.text}
              </blockquote>
            ))}
            <p className="maka-quote-panel-hint">{copy.hint}</p>
          </div>
        }
        onNew={() => {}}
      />
      {companion.error && <div className="maka-quote-companion-error">{companion.error}</div>}
      {(companion.activeSandboxBoundary || companion.activeQuestion) && (
        <div className="maka-composer-interaction-slot">
          {companion.activeSandboxBoundary && (
            <SandboxBoundaryPrompt
              request={companion.activeSandboxBoundary}
              onRespond={companion.respondToSandboxBoundary}
            />
          )}
          {companion.activeQuestion && (
            <UserQuestionPrompt
              request={companion.activeQuestion}
              onRespond={companion.respondToUserQuestion}
              onStop={() => void companion.stop()}
            />
          )}
        </div>
      )}
      <Composer
        ref={composerRef}
        onSend={(text) => companion.send(text)}
        onStop={() => void companion.stop()}
        hidden={Boolean(activeInteraction)}
        streaming={companion.streaming}
        processing={companion.processing}
        draftKey={companion.companionSession?.id ?? `quote-companion:${props.sourceSession?.id ?? 'none'}`}
        disabled={!props.sourceSession}
        pendingQuotes={props.quotes.map((quote) => quote.value)}
        onRemoveQuote={(index) => {
          const quote = props.quotes[index];
          if (quote) {
            props.onRemoveQuote?.({
              panelId: props.panelId,
              quoteId: quote.id,
            });
          }
        }}
        // No activeSession / onModelChange → the model shows as a read-only chip
        // (the companion has no independent picker; it inherits the source model).
        modelLabel={activeModelLabel}
      />
      {props.onClear && (
        <div className="maka-quote-companion-actions">
          <button
            type="button"
            className="maka-quote-panel-clear"
            aria-label={copy.exit}
            onClick={props.onClear}
          >
            {copy.exit}
          </button>
        </div>
      )}
    </div>
  );
}

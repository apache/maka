import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import {
  deriveInspectorPanelModel,
  type InspectorStepRow,
  type InspectorTurnRow,
} from './session-inspector-panel-model.js';
import { useSessionTrace } from './use-session-trace.js';

/**
 * Per-session causal timeline (#1625): what the session did, in order, with
 * what each model call cost and how long it took.
 *
 * Read-only. Every judgement it makes lives in `deriveInspectorPanelModel`;
 * this file lays the result out.
 */
export function SessionInspectorPanel(props: { sessionId: string; active: boolean }) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).inspector;
  const snapshot = useSessionTrace(props.sessionId, props.active);
  const model = deriveInspectorPanelModel(snapshot.trace);

  return (
    <section
      className="maka-inspector-panel"
      data-maka-contract="session-inspector"
      aria-label={copy.ariaLabel}
      aria-busy={snapshot.loading || undefined}
    >
      {snapshot.error && (
        <div className="maka-inspector-error" role="alert">
          <span>{snapshot.error}</span>
          <button type="button" aria-label={copy.retry} onClick={snapshot.retry}>
            {copy.retry}
          </button>
        </div>
      )}

      {model.coverage && (
        <p className="maka-inspector-coverage" data-maka-contract="session-inspector-coverage">
          {model.coverage.kind === 'absent' ? copy.coverageAbsent : copy.coveragePartial}
          {model.coverage.unreadableRecords > 0 &&
            ` · ${model.coverage.unreadableRecords} ${copy.unreadable}`}
        </p>
      )}

      {!model.empty && (
        <header className="maka-inspector-totals">
          <span>{formatDuration(model.totals.durationMs)}</span>
          <span>
            {model.totals.modelAttempts} {copy.attempts}
          </span>
          {model.totals.retries > 0 && (
            <span>
              {model.totals.retries} {copy.retries}
            </span>
          )}
          {model.totals.compactions > 0 && (
            <span>
              {model.totals.compactions} {copy.compactions}
            </span>
          )}
          <span className="maka-inspector-cost">
            {formatCost(model.totals.costUsd, copy.costUnavailable)}
          </span>
        </header>
      )}

      {/* "Nothing to trace" is a claim about the session; a failed read cannot
          make it, so the error stands alone. */}
      {model.empty && !snapshot.loading && !snapshot.error && (
        <p className="maka-inspector-empty">{copy.empty}</p>
      )}

      <ol className="maka-inspector-turns">
        {model.turns.map((turn) => (
          <TurnRow key={turn.turnId} turn={turn} costUnavailable={copy.costUnavailable} failedLabel={copy.turnFailed} />
        ))}
      </ol>
    </section>
  );
}

function TurnRow(props: { turn: InspectorTurnRow; costUnavailable: string; failedLabel: string }) {
  const { turn } = props;
  return (
    <li className="maka-inspector-turn" data-maka-contract="session-inspector-turn">
      <div className="maka-inspector-turn-head">
        <span className="maka-inspector-turn-id">{turn.turnId}</span>
        <span>{formatDuration(turn.durationMs)}</span>
        <span className="maka-inspector-cost">
          {formatCost(turn.totals.costUsd, props.costUnavailable)}
        </span>
        {turn.failed && (
          <span className="maka-inspector-failed" data-maka-contract="session-inspector-turn-failed">
            {props.failedLabel}
            {turn.failureCode ? ` · ${turn.failureCode}` : ''}
          </span>
        )}
      </div>
      <ol className="maka-inspector-steps">
        {turn.steps.map((step) => (
          <StepRow key={step.id} step={step} costUnavailable={props.costUnavailable} />
        ))}
      </ol>
    </li>
  );
}

function StepRow(props: { step: InspectorStepRow; costUnavailable: string }) {
  const { step } = props;
  return (
    <li
      className="maka-inspector-step"
      data-maka-contract="session-inspector-step"
      data-kind={step.kind}
      data-failed={step.failed || undefined}
    >
      <span className="maka-inspector-step-kind">{step.kind}</span>
      <span className="maka-inspector-step-label">{step.label}</span>
      {step.detail && <span className="maka-inspector-step-detail">{step.detail}</span>}
      {step.retries !== undefined && (
        <span className="maka-inspector-step-retries">×{step.retries + 1}</span>
      )}
      {step.durationMs !== undefined && <span>{formatDuration(step.durationMs)}</span>}
      {step.kind === 'model_call' && (
        <span className="maka-inspector-cost">
          {formatCost(step.costUsd, props.costUnavailable)}
        </span>
      )}
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * Absent cost renders as words, never as `$0.00`: the canonical record keeps
 * "nobody could price this" and "this was free" apart, and so does the panel.
 */
function formatCost(costUsd: number | undefined, unavailable: string): string {
  if (costUsd === undefined) return unavailable;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

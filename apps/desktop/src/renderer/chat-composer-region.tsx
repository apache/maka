import type { ComponentProps, Ref } from 'react';
import {
  Composer,
  PermissionPrompt,
  SandboxBoundaryPrompt,
  UserQuestionPrompt,
} from '@maka/ui';
import type { ComposerHandle, ComposerInteraction } from '@maka/ui';

/**
 * The composer region of the chat surface (issue #1043): the composer
 * interaction slot (permission / user-question prompts) plus the always-mounted
 * Composer itself.
 *
 * AppShell renders this as a stable sibling of the section switch, so it is
 * NEVER conditionally mounted - the Composer keeps its uncontrolled textarea
 * and draft across section switches and permission takeovers (#646 draft
 * preservation, permission-composer-takeover contract). `hidden` drives the
 * native hidden state instead of unmounting.
 *
 * Composer props are forwarded via ComponentProps spread; `hidden`,
 * `draftKey`, and `stopPending` are derived here from the active-session state
 * so AppShell only forwards the orchestration callbacks and the session maps.
 */
interface ChatComposerRegionProps extends Omit<ComponentProps<typeof Composer>, 'hidden' | 'draftKey' | 'stopPending'> {
  composerRef: Ref<ComposerHandle>;
  active: boolean;
  onboardingComposerHidden: boolean;
  activeInteraction: ComposerInteraction | undefined;
  activeId: string | undefined;
  stopPendingBySession: Record<string, boolean>;
  activePermission: ComponentProps<typeof PermissionPrompt>['request'] | undefined;
  respondToPermission: ComponentProps<typeof PermissionPrompt>['onRespond'];
  activeSandboxBoundary: ComponentProps<typeof SandboxBoundaryPrompt>['request'] | undefined;
  activeQuestion: ComponentProps<typeof UserQuestionPrompt>['request'] | undefined;
  respondToUserQuestion: ComponentProps<typeof UserQuestionPrompt>['onRespond'];
  stop: ComponentProps<typeof PermissionPrompt>['onStop'];
}

export function ChatComposerRegion({
  composerRef,
  active,
  onboardingComposerHidden,
  activeInteraction,
  activeId,
  stopPendingBySession,
  activePermission,
  respondToPermission,
  activeSandboxBoundary,
  activeQuestion,
  respondToUserQuestion,
  stop,
  ...composerRest
}: ChatComposerRegionProps) {
  return (
    <>
      <div className="maka-composer-interaction-slot">
        {activePermission && (
          <PermissionPrompt
            request={activePermission}
            onRespond={respondToPermission}
            onStop={stop}
            stopPending={activeId ? stopPendingBySession[activeId] === true : false}
          />
        )}
        {activeSandboxBoundary && (
          <SandboxBoundaryPrompt
            request={activeSandboxBoundary}
            onRespond={respondToPermission}
          />
        )}
        {activeQuestion && (
          <UserQuestionPrompt
            request={activeQuestion}
            onRespond={respondToUserQuestion}
            onStop={stop}
            stopPending={activeId ? stopPendingBySession[activeId] === true : false}
          />
        )}
      </div>
      <Composer
        ref={composerRef}
        {...composerRest}
        hidden={!active || onboardingComposerHidden || Boolean(activeInteraction)}
        draftKey={activeId ?? 'new-session'}
        stopPending={activeId ? stopPendingBySession[activeId] === true : false}
      />
    </>
  );
}

import { useState, type FormEvent } from 'react';
import { Button, HStack, TextInput } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';

/** What the sidebar is renaming: one row's session, or a project group's own name. */
export interface SessionRenameTarget {
  kind: 'session' | 'project';
  id: string;
  name: string;
}

/**
 * Renaming from the sidebar, as a dialog rather than in place.
 *
 * The row is an Astryx `SideNavItem`: `label` is a `string` and the whole row
 * is one `<button>`, which no text field may live inside. Editing in place
 * therefore meant swapping the row for a stand-in that had to re-state
 * everything the real row brings — its height and insets, its leading icon and
 * trailing column, and (worst) the subtree, since a parent's descendants live
 * inside the same component. Every one of those was a bug before it was a
 * feature. A dialog costs one glance and leaves the row untouched.
 *
 * The titlebar keeps its in-place edit, and this is not an inconsistency: there
 * the name is the open session's own heading and the breadcrumb crumb is a
 * standalone element built to be replaced. Here the name is one property of a
 * list item, reached through the same `⋯` menu as archive and delete — a
 * dialog is what those actions already look like.
 *
 * One button, no 取消: the header's close control and Escape are already two
 * ways out, which is the convention `ScheduledTaskFormDialog` set.
 */
export function SessionRenameDialog(props: {
  target: SessionRenameTarget;
  onOpenChange(open: boolean): void;
  onRename(target: SessionRenameTarget, name: string): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const target = props.target;
  // Uncontrolled across openings: the dialog is remounted per target (see the
  // `key` at the call site), so the seed is the name as it was when the menu
  // item was chosen, and nothing has to be synchronised while it is open.
  const [name, setName] = useState(target.name);

  const trimmed = name.trim();
  // The row's own vocabulary: a conversation is 对话 everywhere else in the
  // sidebar, and the header doubles as the field's (hidden) label.
  const title = target.kind === 'project' ? copy.renameProjectTitle : copy.renameAriaLabel;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onOpenChange(false);
    // Abandoning is Escape or the header's close control; an empty field cannot
    // reach here, because the only submit affordance is disabled while it is
    // empty. The guard stands for the browsers that run implicit submission
    // through a disabled default button anyway.
    if (trimmed && trimmed !== target.name) props.onRename(target, trimmed);
  }

  return (
    <Dialog isOpen onOpenChange={props.onOpenChange} purpose="form" width={440}>
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={title}
            onOpenChange={props.onOpenChange}
          />
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                variant="primary"
                type="submit"
                form="maka-session-rename-form"
                isDisabled={!trimmed}
                label={copy.renameSubmit}
              />
            </HStack>
          </LayoutFooter>
        }
        content={
          <LayoutContent>
            <form id="maka-session-rename-form" onSubmit={submit}>
              <TextInput
                label={title}
                // Hidden: the dialog's own header already says what is being
                // renamed, and Astryx clips the whole label block — a
                // `description` under a hidden label is invisible too, so
                // there is no hint to put there.
                isLabelHidden
                value={name}
                // A session name is a label, not a document; the same 80 the
                // titlebar's field takes.
                onChange={(value) => setName(value.slice(0, 80))}
                hasAutoFocus
                width="100%"
              />
            </form>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

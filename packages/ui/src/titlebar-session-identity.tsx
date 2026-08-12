import { useEffect, useRef, useState } from 'react';
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs';
import { Icon } from '@astryxdesign/core/Icon';
import { getConversationCopy } from './conversation-copy.js';
import { InlineRenameInput } from './inline-rename-input.js';
import { useUiLocale } from './locale-context.js';

/**
 * Which project a session belongs to, as the titlebar needs to say it.
 *
 * `name` is the project record's name when the session is bound to one, and
 * the working directory's own folder name when it only has a cwd — the
 * titlebar answers "where am I", and a directory answers that whether or not
 * the user ever registered it as a project.
 */
export interface TitlebarProject {
  name: string;
  onOpenFolder?(): void;
}

/**
 * What to call the session's directory in the titlebar.
 *
 * A registered project's own name wins. Failing that, a session still has a
 * cwd, and its folder name answers "where am I" perfectly well — the titlebar
 * would otherwise fall silent for exactly the sessions started outside the
 * project catalog. Undefined only when there is no directory at all, which
 * collapses the breadcrumb to the session name alone.
 *
 * Splits on both separators: the path comes from the host OS, so a Windows
 * session yields backslashes. Trailing separators are dropped first, so
 * `/a/b/` names `b` rather than nothing, and a bare root names nothing rather
 * than an empty segment.
 */
export function deriveTitlebarProjectName(options: {
  projectName?: string;
  projectPath?: string;
}): string | undefined {
  if (options.projectName) return options.projectName;
  const path = options.projectPath?.replace(/[/\\]+$/, '');
  if (!path) return undefined;
  return path.split(/[/\\]/).pop() || undefined;
}

/**
 * Parent session trail segment for a linked subagent open in the main column.
 * Clicking returns to the parent; the child is never listed in the sidebar.
 */
export interface TitlebarParentSession {
  name: string;
  onOpen(): void;
}

/**
 * The session's identity in the window titlebar: `project › session name`,
 * or `project › parent › child` when a linked subagent is open.
 *
 * Before this, an open session showed neither. The name lived only in the
 * sidebar list — gone the moment the sidebar was collapsed — and the project
 * lived only in the composer's WorkspacePicker, which renders only while NO
 * session owns it, so it disappeared at the very moment the session gained a
 * directory to be in.
 *
 * A breadcrumb rather than two labels: the session genuinely hangs off the
 * project, it is the trail `SessionContextLayer` already speaks for session
 * lineage, and it degrades to a single item when there is no project.
 *
 * The interactive segments carve `no-drag` rectangles out of the titlebar's
 * drag surface, the same way the left rail and the workspace actions do. Each
 * covers only its own text, so the strip stays draggable around them.
 */
export function TitlebarSessionIdentity(props: {
  sessionName: string;
  onRenameSession(name: string): void;
  project?: TitlebarProject;
  /** Immediate linked parent when viewing a child subagent session. */
  parentSession?: TitlebarParentSession;
}) {
  const copy = getConversationCopy(useUiLocale());
  const [renaming, setRenaming] = useState(false);
  const trailRef = useRef<HTMLDivElement>(null);
  const handBackFocusRef = useRef(false);

  /**
   * Where focus goes when the edit ends.
   *
   * The crumb the user pressed to start the rename is not hidden while the
   * field is up — it is unmounted — so when the edit ends a NEW button takes
   * its place and focus has nowhere to fall back to but the document body,
   * which puts the next Tab at the top of the window. Only a keyboard exit
   * hands it back: a click-away already moved focus somewhere the user picked.
   */
  function endRename(handBackFocus: boolean) {
    handBackFocusRef.current = handBackFocus;
    setRenaming(false);
  }

  useEffect(() => {
    if (renaming || !handBackFocusRef.current) return;
    handBackFocusRef.current = false;
    trailRef.current
      ?.querySelector('.maka-titlebar-identity__segment--session')
      ?.closest('button')
      ?.focus();
  }, [renaming]);

  return (
    <div
      className="maka-titlebar-identity"
      data-maka-contract="titlebar-identity"
      ref={trailRef}
    >
      {/* `default`, not `supporting`. Astryx documents supporting as the variant
          for dense UIs "where the breadcrumb should be subtle", which this is
          the opposite of: it is the window's statement of which session is
          open. On supporting it rendered 12px/400/secondary — smaller, lighter
          and greyer than the SAME session's row in the sidebar (14px/500/
          primary), so the highest-level label in the window was the weakest. */}
      <Breadcrumbs
        label={copy.chat.titlebarIdentityAriaLabel}
        className="maka-titlebar-identity__breadcrumbs"
        separator={<Icon icon="chevronRight" size="xsm" />}
      >
        {/* The action is named inside the button, not on the <li>: BreadcrumbItem
            spreads unknown props onto the list item, so an `aria-label` there
            would leave the control itself still announced as the bare
            "示例项目, button" — a name that says where it points but not that
            pressing it does anything. The hidden phrase joins the visible text
            in the name computation; `title` stays for the mouse. */}
        {props.project ? (
          <BreadcrumbItem onClick={props.project.onOpenFolder}>
            <span
              className="maka-titlebar-identity__segment"
              title={props.project.onOpenFolder
                ? copy.chat.openProjectFolder(props.project.name)
                : props.project.name}
            >
              {props.project.name}
            </span>
            {props.project.onOpenFolder ? (
              <span className="maka-visually-hidden">
                {copy.chat.openProjectFolderAction}
              </span>
            ) : null}
          </BreadcrumbItem>
        ) : null}
        {props.parentSession ? (
          <BreadcrumbItem onClick={props.parentSession.onOpen}>
            <span
              className="maka-titlebar-identity__segment"
              title={copy.chat.openParentSession(props.parentSession.name)}
            >
              {props.parentSession.name}
            </span>
            <span className="maka-visually-hidden">
              {copy.chat.openParentSessionAction}
            </span>
          </BreadcrumbItem>
        ) : null}
        {/* The rename happens INSIDE this crumb, not in place of the whole
            trail. Swapping the trail wholesale unmounted the project crumb and
            the separator, so starting a rename made the two things beside the
            field disappear and the row re-lay out around a fixed-width input.
            The edit is to one segment; only that segment should change. */}
        {renaming ? (
          <BreadcrumbItem isCurrent={false}>
            <InlineRenameInput
              className="maka-titlebar-identity__rename-input"
              defaultValue={props.sessionName}
              ariaLabel={copy.sessions.renameAriaLabel}
              onCommit={(name, via) => {
                endRename(via === 'keyboard');
                // An empty field is an abandoned edit, not a request for a
                // session with no name — the sidebar's rename reads it the
                // same way.
                if (name && name !== props.sessionName) props.onRenameSession(name);
              }}
              onCancel={() => endRename(true)}
            />
          </BreadcrumbItem>
        ) : (
          /* `isCurrent={false}`, not the default: a current crumb renders as a
             plain <span aria-current="page"> and DROPS onClick, so the rename
             affordance would be dead and keyboard-unreachable. Passing false
             also opts out of the auto-last-item detection — which would not
             take the button away, but would mark an ACTION as the current
             page. What is left is a link-styled <button>, correct here since
             this crumb is something you do, not somewhere you are. */
          <BreadcrumbItem isCurrent={false} onClick={() => setRenaming(true)}>
            <span
              className="maka-titlebar-identity__segment maka-titlebar-identity__segment--session"
              title={copy.sessions.renameAriaLabel}
            >
              {props.sessionName}
            </span>
            <span className="maka-visually-hidden">{copy.sessions.renameAriaLabel}</span>
          </BreadcrumbItem>
        )}
      </Breadcrumbs>
    </div>
  );
}

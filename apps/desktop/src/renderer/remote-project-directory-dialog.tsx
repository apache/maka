import { useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { useUiLocale } from '@maka/ui';
import { Check, Eye, EyeOff, FolderOpen } from '@maka/ui/icons';
import type {
  DesktopProjectDirectoryEntry,
  DesktopProjectDirectoryRoot,
  DesktopRuntimeHostRef,
} from '../preload/bridge-contract.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type DirectoryHost = DesktopRuntimeHostRef & { readonly name?: string };
type DirectoryLoad =
  | { readonly kind: 'initial'; readonly host: DirectoryHost }
  | {
      readonly kind: 'directory';
      readonly host: DirectoryHost;
      readonly root: DesktopProjectDirectoryRoot;
      readonly segments: readonly string[];
    };
type DirectoryError = {
  readonly message: string;
  readonly retryable: boolean;
};

export function RemoteProjectDirectoryDialog(props: {
  host?: DirectoryHost;
  onClose(): void;
  onRegistered(project: ProjectRecord, host: DesktopRuntimeHostRef): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).projectActions;
  const [roots, setRoots] = useState<readonly DesktopProjectDirectoryRoot[]>([]);
  const [root, setRoot] = useState<DesktopProjectDirectoryRoot>();
  const [segments, setSegments] = useState<readonly string[]>([]);
  const [entries, setEntries] = useState<readonly DesktopProjectDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<DirectoryError>();
  const request = useRef(0);
  const lastLoad = useRef<DirectoryLoad | undefined>(undefined);

  useEffect(() => {
    const host = props.host;
    if (!host) return;
    void load({ kind: 'initial', host });
    return () => {
      request.current += 1;
    };
  }, [props.host?.profileId, props.host?.hostId, locale]);

  async function load(target: DirectoryLoad): Promise<void> {
    const sequence = ++request.current;
    lastLoad.current = target;
    if (target.kind === 'initial') {
      setRoots([]);
      setRoot(undefined);
      setSegments([]);
      setEntries([]);
      setShowHidden(false);
    }
    setLoading(true);
    setError(undefined);
    try {
      if (target.kind === 'initial') {
        const nextRoots = await window.maka.projects.getDirectoryRoots(target.host);
        const nextRoot = nextRoots[0];
        if (!nextRoot) throw new Error('Runtime Host did not publish a project directory');
        const next = await window.maka.projects.listDirectory({
          rootId: nextRoot.id,
          segments: [],
        }, target.host);
        if (request.current !== sequence) return;
        setRoots(nextRoots);
        setRoot(nextRoot);
        setSegments([]);
        setEntries(next);
        return;
      }
      const next = await window.maka.projects.listDirectory({
        rootId: target.root.id,
        segments: target.segments,
      }, target.host);
      if (request.current !== sequence) return;
      setRoot(target.root);
      setSegments(target.segments);
      setEntries(next);
    } catch (cause) {
      if (request.current !== sequence) return;
      setError({
        message: localizedShellErrorMessage(cause, copy.readPathFailedFallback, locale),
        retryable: true,
      });
    } finally {
      if (request.current === sequence) setLoading(false);
    }
  }

  function navigate(nextSegments: readonly string[]): void {
    const host = props.host;
    if (!host || !root || loading || registering) return;
    void load({ kind: 'directory', host, root, segments: nextSegments });
  }

  function selectRoot(nextRoot: DesktopProjectDirectoryRoot): void {
    const host = props.host;
    if (
      !host ||
      loading ||
      registering ||
      (nextRoot.id === root?.id && segments.length === 0)
    ) return;
    void load({ kind: 'directory', host, root: nextRoot, segments: [] });
  }

  async function register(): Promise<void> {
    const host = props.host;
    if (!host || !root || loading || registering) return;
    const sequence = ++request.current;
    setRegistering(true);
    setError(undefined);
    try {
      const project = await window.maka.projects.registerDirectory({
        rootId: root.id,
        segments,
      }, host);
      if (request.current !== sequence) return;
      props.onRegistered(project, host);
    } catch (cause) {
      if (request.current !== sequence) return;
      setError({
        message: localizedShellErrorMessage(cause, copy.projectUpdateFailedFallback, locale),
        retryable: false,
      });
    } finally {
      if (request.current === sequence) setRegistering(false);
    }
  }

  function retry(): void {
    const target = lastLoad.current;
    const host = props.host;
    if (!target || !host || loading || registering || !sameHost(target.host, host)) return;
    void load(target);
  }

  function dismiss(): void {
    request.current += 1;
    setLoading(false);
    setRegistering(false);
    props.onClose();
  }

  const host = props.host;
  const visibleEntries = showHidden
    ? entries
    : entries.filter((entry) => !entry.name.startsWith('.'));
  return (
    <Dialog
      isOpen={host !== undefined}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      purpose="form"
      width={560}
      maxHeight="calc(100dvh - 64px)"
      className="remoteProjectDirectoryDialog"
    >
      <Layout
        header={host ? (
          <DialogHeader
            title={copy.remoteDirectoryTitle(host.name ?? 'Runtime Host')}
            onOpenChange={(open) => {
              if (!open) dismiss();
            }}
          />
        ) : undefined}
        content={
          <LayoutContent padding={4}>
            <div className="remoteProjectDirectoryBody">
              <nav
                className="remoteProjectDirectoryBreadcrumbs"
                aria-label={copy.remoteDirectoryBreadcrumbs}
              >
                {roots.length > 1 ? (
                  <DropdownMenu
                    placement="below"
                    button={{
                      className: 'remoteProjectDirectoryRoot',
                      variant: 'ghost',
                      size: 'sm',
                      label: root?.label ?? copy.remoteDirectoryHome,
                      isDisabled: loading || registering,
                    }}
                  >
                    {roots.map((candidate) => (
                      <DropdownMenuItem
                        key={candidate.id}
                        label={candidate.label}
                        icon={<FolderOpen size={18} aria-hidden="true" />}
                        endContent={candidate.id === root?.id
                          ? <Check size={18} aria-hidden="true" />
                          : undefined}
                        onClick={() => selectRoot(candidate)}
                      />
                    ))}
                  </DropdownMenu>
                ) : (
                  <Button
                    className="remoteProjectDirectoryRoot"
                    variant="ghost"
                    size="sm"
                    label={root?.label ?? copy.remoteDirectoryHome}
                    isDisabled={loading || registering}
                    onClick={() => navigate([])}
                  />
                )}
                {segments.map((segment, index) => (
                  <Button
                    className="remoteProjectDirectoryBreadcrumb"
                    key={`${index}:${segment}`}
                    variant="ghost"
                    size="sm"
                    label={segment}
                    isDisabled={loading || registering}
                    onClick={() => navigate(segments.slice(0, index + 1))}
                  />
                ))}
              </nav>
              {error ? (
                <div className="remoteProjectDirectoryError" role="alert">
                  <Text type="body" color="secondary">{error.message}</Text>
                  {error.retryable ? (
                    <Button label={copy.remoteDirectoryRetry} variant="ghost" onClick={retry} />
                  ) : null}
                </div>
              ) : loading ? (
                <Text type="body" color="secondary">{copy.remoteDirectoryLoading}</Text>
              ) : visibleEntries.length === 0 ? (
                <Text type="body" color="secondary">{copy.remoteDirectoryEmpty}</Text>
              ) : (
                <div className="remoteProjectDirectoryEntries">
                  {visibleEntries.map((entry) => (
                    <Button
                      className="remoteProjectDirectoryEntry"
                      key={entry.name}
                      variant="ghost"
                      label={entry.name}
                      icon={<FolderOpen size={18} aria-hidden="true" />}
                      isDisabled={registering}
                      onClick={() => navigate([...segments, entry.name])}
                    />
                  ))}
                </div>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                label={showHidden
                  ? copy.remoteDirectoryHideHidden
                  : copy.remoteDirectoryShowHidden}
                icon={showHidden
                  ? <Eye size={18} aria-hidden="true" />
                  : <EyeOff size={18} aria-hidden="true" />}
                aria-pressed={showHidden}
                isDisabled={registering}
                onClick={() => setShowHidden((current) => !current)}
              />
              <HStack gap={2}>
                <Button variant="ghost" label={copy.remoteDirectoryCancel} onClick={dismiss} />
                <Button
                  variant="primary"
                  label={copy.remoteDirectorySelect}
                  isDisabled={!root || loading || registering}
                  isLoading={registering}
                  onClick={() => void register()}
                />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function sameHost(left: DesktopRuntimeHostRef, right: DesktopRuntimeHostRef): boolean {
  return left.profileId === right.profileId && left.hostId === right.hostId;
}

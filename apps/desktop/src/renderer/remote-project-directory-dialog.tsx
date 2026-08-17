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

export function RemoteProjectDirectoryDialog(props: {
  host?: DesktopRuntimeHostRef & { readonly name?: string };
  onClose(): void;
  onRegistered(project: ProjectRecord): void;
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
  const [error, setError] = useState<string>();
  const request = useRef(0);

  useEffect(() => {
    const host = props.host;
    if (!host) return;
    const sequence = ++request.current;
    setRoots([]);
    setRoot(undefined);
    setSegments([]);
    setEntries([]);
    setShowHidden(false);
    setError(undefined);
    setLoading(true);
    void window.maka.projects.getDirectoryRoots(host).then(async (nextRoots) => {
      const nextRoot = nextRoots[0];
      if (!nextRoot) throw new Error('Runtime Host did not publish a project directory');
      const next = await window.maka.projects.listDirectory({
        rootId: nextRoot.id,
        segments: [],
      }, host);
      if (request.current !== sequence) return;
      setRoots(nextRoots);
      setRoot(nextRoot);
      setEntries(next);
    }).catch((cause) => {
      if (request.current !== sequence) return;
      setError(localizedShellErrorMessage(cause, copy.readPathFailedFallback, locale));
    }).finally(() => {
      if (request.current === sequence) setLoading(false);
    });
    return () => {
      request.current += 1;
    };
  }, [props.host?.profileId, props.host?.hostId, locale]);

  async function navigate(nextSegments: readonly string[]): Promise<void> {
    const host = props.host;
    if (!host || !root) return;
    const sequence = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.maka.projects.listDirectory({
        rootId: root.id,
        segments: nextSegments,
      }, host);
      if (request.current !== sequence) return;
      setSegments(nextSegments);
      setEntries(next);
    } catch (cause) {
      if (request.current !== sequence) return;
      setError(localizedShellErrorMessage(cause, copy.readPathFailedFallback, locale));
    } finally {
      if (request.current === sequence) setLoading(false);
    }
  }

  async function selectRoot(nextRoot: DesktopProjectDirectoryRoot): Promise<void> {
    const host = props.host;
    if (!host || loading || nextRoot.id === root?.id) return;
    const sequence = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.maka.projects.listDirectory({
        rootId: nextRoot.id,
        segments: [],
      }, host);
      if (request.current !== sequence) return;
      setRoot(nextRoot);
      setSegments([]);
      setEntries(next);
    } catch (cause) {
      if (request.current !== sequence) return;
      setError(localizedShellErrorMessage(cause, copy.readPathFailedFallback, locale));
    } finally {
      if (request.current === sequence) setLoading(false);
    }
  }

  async function register(): Promise<void> {
    const host = props.host;
    if (!host || !root || registering) return;
    setRegistering(true);
    setError(undefined);
    try {
      props.onRegistered(await window.maka.projects.registerDirectory({
        rootId: root.id,
        segments,
      }, host));
    } catch (cause) {
      setError(localizedShellErrorMessage(cause, copy.projectUpdateFailedFallback, locale));
    } finally {
      setRegistering(false);
    }
  }

  const host = props.host;
  const visibleEntries = showHidden
    ? entries
    : entries.filter((entry) => !entry.name.startsWith('.'));
  return (
    <Dialog
      isOpen={host !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
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
              if (!open) props.onClose();
            }}
          />
        ) : undefined}
        content={
          <LayoutContent padding={4}>
            <div className="remoteProjectDirectoryBody">
              <nav className="remoteProjectDirectoryBreadcrumbs" aria-label={copy.currentProject}>
                {roots.length > 1 ? (
                  <DropdownMenu
                    placement="below"
                    button={{
                      className: 'remoteProjectDirectoryRoot',
                      variant: 'ghost',
                      size: 'sm',
                      label: root?.label ?? copy.remoteDirectoryHome,
                      isDisabled: loading,
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
                        onClick={() => void selectRoot(candidate)}
                      />
                    ))}
                  </DropdownMenu>
                ) : (
                  <Button
                    className="remoteProjectDirectoryRoot"
                    variant="ghost"
                    size="sm"
                    label={root?.label ?? copy.remoteDirectoryHome}
                    isDisabled={loading}
                    onClick={() => void navigate([])}
                  />
                )}
                {segments.map((segment, index) => (
                  <Button
                    className="remoteProjectDirectoryBreadcrumb"
                    key={`${index}:${segment}`}
                    variant="ghost"
                    size="sm"
                    label={segment}
                    isDisabled={loading}
                    onClick={() => void navigate(segments.slice(0, index + 1))}
                  />
                ))}
              </nav>
              {error ? (
                <div className="remoteProjectDirectoryError" role="alert">
                  <Text type="body" color="secondary">{error}</Text>
                  <Button label={copy.remoteDirectoryRetry} variant="ghost" onClick={() => void navigate(segments)} />
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
                      onClick={() => void navigate([...segments, entry.name])}
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
                onClick={() => setShowHidden((current) => !current)}
              />
              <HStack gap={2}>
                <Button variant="ghost" label={copy.remoteDirectoryCancel} onClick={props.onClose} />
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

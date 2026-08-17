import { useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { useUiLocale } from '@maka/ui';
import { FolderOpen } from '@maka/ui/icons';
import type {
  DesktopProjectDirectoryEntry,
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
  const [rootId, setRootId] = useState<string>();
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
    setRootId(undefined);
    setSegments([]);
    setEntries([]);
    setShowHidden(false);
    setError(undefined);
    setLoading(true);
    void window.maka.projects.getDirectoryRoots(host).then(async (roots) => {
      const root = roots[0];
      if (!root) throw new Error('Runtime Host did not publish a project directory');
      const next = await window.maka.projects.listDirectory({
        rootId: root.id,
        segments: [],
      }, host);
      if (request.current !== sequence) return;
      setRootId(root.id);
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
    if (!host || !rootId) return;
    const sequence = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.maka.projects.listDirectory({
        rootId,
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

  async function register(): Promise<void> {
    const host = props.host;
    if (!host || !rootId || registering) return;
    setRegistering(true);
    setError(undefined);
    try {
      props.onRegistered(await window.maka.projects.registerDirectory({
        rootId,
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
            subtitle={copy.remoteDirectoryDescription}
            onOpenChange={(open) => {
              if (!open) props.onClose();
            }}
          />
        ) : undefined}
        content={
          <LayoutContent padding={4}>
            <div className="remoteProjectDirectoryBody">
              <nav className="remoteProjectDirectoryBreadcrumbs" aria-label={copy.currentProject}>
                <Button
                  className="remoteProjectDirectoryBreadcrumb"
                  variant="ghost"
                  size="sm"
                  label={copy.remoteDirectoryHome}
                  isDisabled={loading}
                  onClick={() => void navigate([])}
                />
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
              <Switch
                label={copy.remoteDirectoryShowHidden}
                value={showHidden}
                onChange={setShowHidden}
              />
              <HStack gap={2}>
                <Button variant="ghost" label={copy.remoteDirectoryCancel} onClick={props.onClose} />
                <Button
                  variant="primary"
                  label={copy.remoteDirectorySelect}
                  isDisabled={!rootId || loading || registering}
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

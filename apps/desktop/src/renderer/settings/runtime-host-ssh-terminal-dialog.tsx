import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Banner, Button, useUiLocale } from '@maka/ui';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type {
  DesktopRuntimeHostSshTerminalEvent,
  DesktopRuntimeHostSshTerminalSnapshot,
} from '../../preload/bridge-contract.js';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';

const PENDING_OUTPUT_MAX = 64 * 1024;

export function RuntimeHostSshTerminalDialog() {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const pendingOutputRef = useRef('');
  const observationRevisionRef = useRef(0);
  const [isOpen, setIsOpen] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const unsubscribe = window.maka.runtimeHostSshTerminal.subscribe((event) => {
      observationRevisionRef.current += 1;
      acceptEvent(event);
    });
    const revision = observationRevisionRef.current;
    void window.maka.runtimeHostSshTerminal.getSnapshot().then((snapshot) => {
      if (observationRevisionRef.current !== revision) return;
      acceptSnapshot(snapshot);
    });
    return unsubscribe;
  }, []);

  function acceptEvent(event: DesktopRuntimeHostSshTerminalEvent) {
    if (event.kind === 'opened') {
      sessionIdRef.current = event.sessionId;
      pendingOutputRef.current = '';
      setClosed(false);
      setIsOpen(true);
      return;
    }
    if (event.sessionId !== sessionIdRef.current) return;
    if (event.kind === 'data') {
      const terminal = terminalRef.current;
      if (terminal) {
        terminal.write(event.data);
      } else {
        pendingOutputRef.current = `${pendingOutputRef.current}${event.data}`.slice(
          -PENDING_OUTPUT_MAX,
        );
      }
      return;
    }
    if (event.kind === 'connected') {
      sessionIdRef.current = undefined;
      pendingOutputRef.current = '';
      setClosed(false);
      setIsOpen(false);
      return;
    }
    setClosed(true);
  }

  function acceptSnapshot(snapshot: DesktopRuntimeHostSshTerminalSnapshot) {
    if (snapshot.kind === 'idle') return;
    sessionIdRef.current = snapshot.sessionId;
    pendingOutputRef.current = snapshot.output;
    setClosed(snapshot.kind === 'closed');
    setIsOpen(true);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!isOpen || !host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      screenReaderMode: true,
      scrollback: 2_000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    if (pendingOutputRef.current) {
      terminal.write(pendingOutputRef.current);
      pendingOutputRef.current = '';
    }
    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void window.maka.runtimeHostSshTerminal
          .resize(sessionId, terminal.cols, terminal.rows)
          .catch(() => undefined);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const input = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void window.maka.runtimeHostSshTerminal
          .write(sessionId, data)
          .catch(() => undefined);
      }
    });
    requestAnimationFrame(() => {
      resize();
      terminal.focus();
    });
    return () => {
      observer.disconnect();
      input.dispose();
      terminalRef.current = undefined;
      terminal.dispose();
    };
  }, [isOpen]);

  function onOpenChange(open: boolean) {
    if (!open) {
      const sessionId = sessionIdRef.current;
      if (sessionId && !closed) {
        void window.maka.runtimeHostSshTerminal.cancel(sessionId).catch(() => undefined);
      }
    }
    if (!open) {
      sessionIdRef.current = undefined;
      pendingOutputRef.current = '';
    }
    setIsOpen(open);
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className="settingsRuntimeHostSshTerminalDialog"
      width={720}
      maxHeight="calc(100dvh - 64px)"
      purpose="form"
    >
      <Layout
        header={<DialogHeader title={copy.sshTerminalTitle} subtitle={copy.sshTerminalDescription} onOpenChange={onOpenChange} />}
        content={
          <LayoutContent padding={4}>
            <div className="settingsRuntimeHostSshTerminalBody">
              {closed ? <Banner status="error" title={copy.sshTerminalClosed} /> : null}
              <div
                ref={hostRef}
                className="settingsRuntimeHostSshTerminal"
                role="region"
                aria-label={copy.sshTerminalTitle}
              />
            </div>
          </LayoutContent>
        }
        footer={
          closed ? (
            <LayoutFooter hasDivider>
              <div className="settingsRuntimeHostSshTerminalActions">
                <Button
                  variant="primary"
                  label={copy.sshTerminalClose}
                  onClick={() => onOpenChange(false)}
                />
              </div>
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}

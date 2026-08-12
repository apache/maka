import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Banner, Button } from '@maka/ui';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { DesktopRuntimeHostSshTerminalEvent } from '../../preload/bridge-contract.js';

const PENDING_OUTPUT_MAX = 64 * 1024;

export function RuntimeHostSshTerminalDialog(props: {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly closed: string;
  readonly closeLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const pendingOutputRef = useRef('');
  const [closed, setClosed] = useState(false);

  useEffect(
    () =>
      window.maka.runtimeHostSshTerminal.subscribe((event) => {
        acceptEvent(event);
      }),
    [],
  );

  function acceptEvent(event: DesktopRuntimeHostSshTerminalEvent) {
    if (event.kind === 'opened') {
      sessionIdRef.current = event.sessionId;
      pendingOutputRef.current = '';
      setClosed(false);
      props.onOpenChange(true);
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
    sessionIdRef.current = undefined;
    setClosed(true);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!props.isOpen || !host) return;
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
  }, [props.isOpen]);

  function onOpenChange(open: boolean) {
    if (!open) {
      const sessionId = sessionIdRef.current;
      if (sessionId && !closed) {
        void window.maka.runtimeHostSshTerminal.cancel(sessionId).catch(() => undefined);
      }
    }
    props.onOpenChange(open);
  }

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={onOpenChange}
      className="settingsRuntimeHostSshTerminalDialog"
      width={720}
      maxHeight="calc(100dvh - 64px)"
      purpose="form"
    >
      <Layout
        header={<DialogHeader title={props.title} subtitle={props.description} onOpenChange={onOpenChange} />}
        content={
          <LayoutContent padding={4}>
            <div className="settingsRuntimeHostSshTerminalBody">
              {closed ? <Banner status="error" title={props.closed} /> : null}
              <div
                ref={hostRef}
                className="settingsRuntimeHostSshTerminal"
                role="region"
                aria-label={props.title}
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
                  label={props.closeLabel}
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

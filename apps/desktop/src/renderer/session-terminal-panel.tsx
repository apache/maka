import { useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
} from '@maka/core';
import { useUiLocale } from '@maka/ui';
import { ICON_SIZE, Terminal as TerminalIcon } from '@maka/ui/icons';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { getDesktopConversationCopy } from './locales/conversation-copy';

function terminalTheme(element: HTMLElement) {
  const styles = getComputedStyle(element);
  const value = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value('--agents-content-area-bg', '#111111'),
    foreground: value('--foreground', '#f1f1f1'),
    cursor: value('--foreground', '#f1f1f1'),
    cursorAccent: value('--agents-content-area-bg', '#111111'),
    selectionBackground: value('--accent', 'rgba(128, 128, 128, 0.35)'),
  };
}

export function SessionTerminalPanel(props: {
  sessionId: string;
  terminalRef: string | null;
  active: boolean;
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).terminalPanel;
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(props.active);
  const lastSizeRef = useRef('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    activeRef.current = props.active;
    if (!props.active) return;
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    requestAnimationFrame(() => {
      if (!activeRef.current) return;
      fit.fit();
      terminal.focus();
    });
  }, [props.active]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !props.terminalRef) return;

    lastSizeRef.current = '';
    let disposed = false;
    let attached = false;
    let lastSequence = 0;
    const pending: Array<{ sequence: number; data: string }> = [];
    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      letterSpacing: 0,
      lineHeight: 1.2,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: terminalTheme(host),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const writeEvent = (event: { sequence: number; data: string }) => {
      if (event.sequence <= lastSequence) return;
      if (!attached) {
        pending.push(event);
        return;
      }
      lastSequence = event.sequence;
      terminal.write(event.data);
    };
    const unsubscribe = window.maka.shellRuns.subscribePtyData((event) => {
      if (
        event.sessionId !== props.sessionId ||
        event.ref !== props.terminalRef ||
        disposed
      ) {
        return;
      }
      writeEvent(event);
    });
    const inputSubscription = terminal.onData((input) => {
      if (!input || disposed) return;
      void window.maka.shellRuns
        .write({
          sessionId: props.sessionId,
          ref: props.terminalRef!,
          input,
        })
        .catch((nextError) => {
          if (disposed) return;
          setError(
            locale === 'zh'
              ? generalizedErrorMessageChinese(nextError, copy.writeFailed)
              : generalizedErrorMessage(nextError, copy.writeFailed),
          );
        });
    });
    const resize = () => {
      if (disposed || !activeRef.current || host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }
      fit.fit();
      const key = `${terminal.cols}:${terminal.rows}`;
      if (lastSizeRef.current === key) return;
      lastSizeRef.current = key;
      void window.maka.shellRuns
        .write({
          sessionId: props.sessionId,
          ref: props.terminalRef!,
          size: { cols: terminal.cols, rows: terminal.rows },
        })
        .catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    setError(null);
    void window.maka.shellRuns
      .attach({ sessionId: props.sessionId, ref: props.terminalRef })
      .then((snapshot) => {
        if (disposed) return;
        if (!snapshot) {
          setError(copy.loadFailed);
          return;
        }
        terminal.reset();
        if (snapshot.buffer) terminal.write(snapshot.buffer);
        lastSequence = snapshot.sequence;
        attached = true;
        pending
          .filter((event) => event.sequence > lastSequence)
          .sort((left, right) => left.sequence - right.sequence)
          .forEach(writeEvent);
        pending.length = 0;
        requestAnimationFrame(() => {
          resize();
          if (activeRef.current) terminal.focus();
        });
      })
      .catch((nextError) => {
        if (disposed) return;
        setError(
          locale === 'zh'
            ? generalizedErrorMessageChinese(nextError, copy.loadFailed)
            : generalizedErrorMessage(nextError, copy.loadFailed),
        );
      });

    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribe();
      inputSubscription.dispose();
      void window.maka.shellRuns
        .detach({ sessionId: props.sessionId, ref: props.terminalRef! })
        .catch(() => {});
      fitRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [
    copy.loadFailed,
    copy.writeFailed,
    locale,
    props.sessionId,
    props.terminalRef,
  ]);

  if (!props.terminalRef) {
    return (
      /* Panel empty (DESIGN.md §10 tier 2): the whole panel is empty, so it
         carries icon and description, not the compact form. */
      <EmptyState
        icon={<TerminalIcon size={ICON_SIZE.empty} aria-hidden />}
        title={copy.empty}
        description={copy.emptyHelp}
      />
    );
  }

  return (
    <div
      className="maka-session-terminal-panel"
      role="region"
      aria-label={copy.ariaLabel}
      data-terminal-ref={props.terminalRef}
    >
      {error ? <Banner status="error" title={error} /> : null}
      <div
        ref={hostRef}
        className="maka-session-terminal-xterm"
        data-maka-contract="session-terminal-xterm"
      />
    </div>
  );
}

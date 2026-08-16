import { createRoot } from 'react-dom/client';
import { syncUiLocaleDocument } from '@maka/ui';
import { App } from './app';
import { applyCachedThemeBeforeMount } from './cached-theme-bootstrap';
import type { OnboardingSnapshot } from '../preload/bridge-contract.js';
import './styles.css';
import { readSystemUiLocale } from './use-system-ui-locale';

const ONBOARDING_SNAPSHOT_RETRY_DELAY_MS = 150;
const ONBOARDING_SNAPSHOT_TIMEOUT_MS = 2_500;

syncUiLocaleDocument(readSystemUiLocale());
applyCachedThemeBeforeMount();

/**
 * Prefetch the onboarding snapshot BEFORE mounting React. The preload
 * skeleton (index.html) stays on screen while this resolves, so the first
 * React commit already has sessions + connections and paints the real
 * chat surface directly — no intermediate loading card, no layout jump
 * (the "配置页闪了一下" startup flash).
 *
 * Fail-open: one quick retry (the IPC handler may not be registered in
 * the first milliseconds), then a hard timeout so a wedged main process
 * can never block the renderer from mounting. On timeout/failure React
 * mounts with `null` and the classic in-app loading path takes over.
 */
async function prefetchOnboardingSnapshot(): Promise<OnboardingSnapshot | null> {
  const attempt = async (): Promise<OnboardingSnapshot | null> => {
    try {
      return await window.maka.onboarding.getSnapshot();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, ONBOARDING_SNAPSHOT_RETRY_DELAY_MS));
      try {
        return await window.maka.onboarding.getSnapshot();
      } catch {
        return null;
      }
    }
  };
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ONBOARDING_SNAPSHOT_TIMEOUT_MS));
  return Promise.race([attempt(), timeout]);
}

void prefetchOnboardingSnapshot().then((initialOnboardingSnapshot) => {
  createRoot(document.getElementById('root')!).render(
    <App initialOnboardingSnapshot={initialOnboardingSnapshot} />,
  );
});

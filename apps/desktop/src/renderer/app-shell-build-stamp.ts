import { useEffect, useState } from 'react';
import type { SidebarBuildStamp } from '@maka/ui';

/**
 * The running build, for the rail's footer.
 *
 * Read once at mount and never again: neither the version nor the commit can
 * change without the process restarting, so a subscription would re-render for
 * a value that cannot move.
 *
 * Failure is silent and the stamp is simply absent. This is an orientation
 * label — a rail that shows nothing is strictly better than one that shows an
 * error where a version belongs, and the About page reports the same failure
 * where a user went looking for it.
 */
export function useBuildStamp(): SidebarBuildStamp | undefined {
  const [stamp, setStamp] = useState<SidebarBuildStamp | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    window.maka.app
      .info()
      .then((info) => {
        if (cancelled) return;
        setStamp({ version: info.appVersion, commit: info.buildCommit });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return stamp;
}

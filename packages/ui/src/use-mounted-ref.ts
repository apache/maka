import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/* PR-SIMPLIFY-ROUND-D-0: the fail-soft settings surfaces each hand-rolled
   the same mounted guard (a ref set true on mount, false on unmount, read
   before every post-await setState/toast). One shared hook replaces the
   boilerplate; components that must also reset their own refs on unmount
   keep a separate cleanup effect for those.

   Starts true (not false) so reads during the first render — before
   effects run — already report "mounted"; the effect re-arms it for
   StrictMode's mount → unmount → remount double-invoke. */
export function useMountedRef(): RefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

declare module 'fs-native-extensions' {
  export interface LockOptions {
    shared?: boolean;
  }

  export function tryLock(fd: number, options?: LockOptions): boolean;
  export function waitForLock(fd: number, options?: LockOptions): Promise<void>;
  export function unlock(fd: number): void;
}

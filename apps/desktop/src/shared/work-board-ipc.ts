import type { WorkBoardStoreErrorCode } from '@maka/storage/work-board-store';

export type WorkBoardIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: WorkBoardStoreErrorCode | 'unknown';
      readonly message: string;
    };

export interface WorkBoardChangedEvent {
  readonly type: 'work_board_changed';
  readonly ts: number;
}

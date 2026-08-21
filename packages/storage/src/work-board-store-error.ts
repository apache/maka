export type WorkBoardStoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'operation_conflict'
  | 'corrupt_record'
  | 'must_archive_first';

export class WorkBoardStoreError extends Error {
  readonly code: WorkBoardStoreErrorCode;

  constructor(code: WorkBoardStoreErrorCode, message: string) {
    super(message);
    this.name = 'WorkBoardStoreError';
    this.code = code;
  }
}

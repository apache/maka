/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
export class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

import { compileCronExpression } from '@maka/core/cron-expression';
import { SCHEDULED_TASK_CRON_MAX_CHARS } from '@maka/core/scheduled-task';

/** Converts the one released Plan Reminder grammar difference into current cron syntax. */
export function canonicalizeLegacyPlanReminderCronExpression(expression: string): string {
  if ([...expression].length > SCHEDULED_TASK_CRON_MAX_CHARS) throw invalidCron(expression);
  const parts = expression.split(' ');
  if (parts.length !== 5 || !compileCronExpression(expression).ok) throw invalidCron(expression);
  const canonical = parts
    .map((field) =>
      field
        .split(',')
        .map((token) => token.match(/^(\d+)\/\d+$/)?.[1] ?? token)
        .join(','),
    )
    .join(' ');
  if (!compileCronExpression(canonical).ok) throw invalidCron(expression);
  return canonical;
}

function invalidCron(expression: string): Error {
  return new Error(`Invalid legacy Plan Reminder cron expression: ${expression}`);
}

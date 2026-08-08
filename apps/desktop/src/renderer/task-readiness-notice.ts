import type {
  TaskSubmissionReadinessDimension,
  TaskSubmissionReadinessSnapshot,
  UiLocale,
} from '@maka/core';

export interface TaskReadinessNotice {
  tone: 'warning' | 'destructive';
  title: string;
  description: string;
  actionLabel: string;
  action: 'retry' | 'new_task';
}

export function isTaskSubmissionHardBlocked(
  snapshot: TaskSubmissionReadinessSnapshot | undefined,
): boolean {
  return snapshot?.state === 'repair_required' || snapshot?.state === 'unavailable';
}

/** Model blockers already have connection-specific recovery surfaces. */
export function deriveTaskReadinessNotice(
  snapshot: TaskSubmissionReadinessSnapshot | undefined,
  locale: UiLocale,
): TaskReadinessNotice | undefined {
  if (!snapshot) return undefined;
  const blocker = snapshot.blockers.find(
    (candidate) =>
      candidate.state !== 'unknown' &&
      (candidate.id === 'runtime' || candidate.id === 'workspace'),
  );
  if (!blocker) return undefined;
  return noticeForBlocker(blocker, locale);
}

function noticeForBlocker(
  blocker: TaskSubmissionReadinessDimension,
  locale: UiLocale,
): TaskReadinessNotice {
  if (blocker.id === 'runtime') {
    return locale === 'zh'
      ? {
          tone: 'destructive',
          title: 'Maka 运行服务暂时不可用。',
          description: '任务尚未提交。重新检测运行服务后再试。',
          actionLabel: '重新检测',
          action: 'retry',
        }
      : {
          tone: 'destructive',
          title: 'The Maka runtime is unavailable.',
          description: 'The task was not submitted. Check the runtime again before retrying.',
          actionLabel: 'Check again',
          action: 'retry',
        };
  }
  return locale === 'zh'
    ? {
        tone: 'destructive',
        title: '当前任务的工作区不可用。',
        description: '原目录可能已移动、删除或无法访问。请新建任务并选择可用工作区。',
        actionLabel: '新建任务',
        action: 'new_task',
      }
    : {
        tone: 'destructive',
        title: 'This task workspace is unavailable.',
        description: 'The folder may have moved, been deleted, or become inaccessible. Start a new task with an available workspace.',
        actionLabel: 'New task',
        action: 'new_task',
      };
}

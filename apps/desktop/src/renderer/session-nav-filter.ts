import type { SessionSummary } from '@maka/core/session';
import type { NavSelection } from '@maka/ui';

export function sessionMatchesNavSelection(
  session: SessionSummary,
  selection: NavSelection,
): boolean {
  const filter = selection.section === 'sessions' ? selection.filter : 'chats';
  switch (filter) {
    case 'flagged':
      return session.isFlagged && !session.isArchived;
    case 'archived':
      return session.isArchived;
    case 'chats':
      return !session.isArchived;
  }
}

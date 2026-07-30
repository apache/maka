import type { SessionSummary } from '@maka/core';
import type { NavSelection } from '@maka/ui';

export function sessionMatchesNavSelection(
  session: SessionSummary,
  selection: NavSelection,
): boolean {
  const filter = selection.section === 'sessions' ? selection.filter : 'chats';
  switch (filter) {
    case 'flagged':
      return Boolean(session.isFlagged && !session.isArchived && session.lastMessageAt);
    case 'archived':
      return session.isArchived;
    case 'chats':
      return Boolean(!session.isArchived && session.lastMessageAt);
  }
}

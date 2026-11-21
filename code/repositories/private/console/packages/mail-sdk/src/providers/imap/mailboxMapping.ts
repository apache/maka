/** IMAP special-use 标志 → 统一 SpecialRole 映射(纯函数)。 */
import type { SpecialRole } from '../../types/mail.js';

export function specialUseToRole(specialUse?: string): SpecialRole | undefined {
    if (!specialUse) return undefined;
    const s = specialUse.toLowerCase().replace(/\\/g, '');
    if (s.includes('inbox')) return 'inbox';
    if (s.includes('sent')) return 'sent';
    if (s.includes('draft')) return 'drafts';
    if (s.includes('trash') || s.includes('deleted')) return 'trash';
    if (s.includes('junk') || s.includes('spam')) return 'junk';
    if (s.includes('all')) return 'all';
    if (s.includes('archive')) return 'archive';
    return undefined;
}

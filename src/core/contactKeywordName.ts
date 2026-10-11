/** CONTACT options are movable groups; words inside a contact type are not.
 * LS-DYNA Keyword Manual R6.1, Vol I, CONTACT 11-4, remark 1:
 * https://lsdyna.ansys.com/wp-content/uploads/2025/02/LS-DYNA_manual_Vol_I_R6.1.0.pdf
 * Recognition still requires an existing catalog entry for the complete combination.
 */
const groups = [
    ['THERMAL_FRICTION', 'THERMAL'], ['ID'],
    ['CONSTRAINED_OFFSET', 'BEAM_OFFSET', 'OFFSET'], ['MPP'], ['ORTHO_FRICTION'],
];

export function contactKeywordParts(name: string): { type: string; options: string[] } | null {
    if (!name.startsWith('CONTACT_') || name.startsWith('CONTACT_2D_')) return null;
    let remaining = name.slice('CONTACT_'.length);
    const selected = new Map<number, string>();
    while (remaining) {
        let found = false;
        for (const [slot, choices] of groups.entries()) {
            const option = choices.find(value => remaining.startsWith(value + '_') || remaining.endsWith('_' + value));
            if (!option) continue;
            if (selected.has(slot)) return null;
            selected.set(slot, option);
            remaining = remaining.startsWith(option + '_')
                ? remaining.slice(option.length + 1) : remaining.slice(0, -option.length - 1);
            found = true;
            break;
        }
        if (!found) break;
    }
    if (!remaining || remaining.split('_').some(token => !token)) return null;
    return { type: 'CONTACT_' + remaining, options: [...selected.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) };
}

export function contactKeywordKey(name: string): string | null {
    const parts = contactKeywordParts(name);
    return parts ? [parts.type, ...parts.options].join('|') : null;
}

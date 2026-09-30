export function generateCommentLine(card, style = 'dollar-hash-fixed', labelCase = 'lower') {
    if (!card || card.length === 0) return '';
    const maximumEnd = card.reduce((maximum, field) => {
        const end = Number(field?.p) + Number(field?.w);
        return Number.isFinite(end) ? Math.max(maximum, end) : maximum;
    }, 0);
    if (maximumEnd <= 0) return '';
    const marker = style === 'dollar-hash-fixed' ? '$#' : '$';
    if (card.some((field, index) => card.slice(index + 1).some(other =>
        Math.max(Number(field.p), Number(other.p)) < Math.min(Number(field.p) + Number(field.w), Number(other.p) + Number(other.w))))) {
        return marker + ' ' + card.map(field => {
            const name = labelCase === 'upper' ? String(field.n).toUpperCase() : String(field.n).toLowerCase();
            return `${name} [${Number(field.p) + 1}-${Number(field.p) + Number(field.w)}]`;
        }).join(' | ');
    }
    const characters = Array(maximumEnd).fill(' ');
    characters[0] = '$';
    if (marker.length === 2 && maximumEnd > 1) characters[1] = '#';

    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const start = Number(f.p);
        const width = Number(f.w);
        if (!Number.isInteger(start) || !Number.isInteger(width) || width < 1) continue;
        const end = start + width;
        let contentStart = start;
        const contentEnd = end;
        if (start === 0) contentStart = marker.length;
        if (style === 'dollar-pipe-fixed' && i > 0) {
            characters[start] = '|';
            contentStart = Math.min(contentEnd, start + 1);
        }
        if (width >= 40 && i === 0) contentStart = Math.min(contentEnd, marker.length + 1);
        const available = contentEnd - contentStart;
        if (available <= 0) continue;

        const rawName = String(f.n || '');
        const casedName = labelCase === 'upper' ? rawName.toUpperCase() : rawName.toLowerCase();
        const name = casedName.substring(0, available);
        if (card.length === 1 && f.w > 80) {
            return `${marker} ${name}`;
        }

        const nameStart = width >= 40
            ? contentStart
            : contentEnd - name.length;
        for (let offset = 0; offset < name.length; offset++) {
            characters[nameStart + offset] = name[offset];
        }
    }
    return characters.join('');
}

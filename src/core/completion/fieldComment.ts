import { safeRecordGeometry } from '../edit/keywordRecordSerializer';
import { resolveCardFromContext, type CardResolution, type KeywordSchema } from '../keywordSchema';
import type { FieldContext } from '../parser/fieldContext';
import { keywordInputFormat } from '../parser/inputFormat';

/** Comment labels do not grant permission to rewrite the corresponding data cells. */
export function resolveCommentCard(context: FieldContext, schema: KeywordSchema): CardResolution {
    if (keywordInputFormat(context.keywordText, context.globalInputFormat) !== 'standard') {
        return { status: 'unsupported', reason: 'non-standard-input' };
    }
    const result = resolveCardFromContext(context, schema);
    const info = result.cardInfo;
    if (!info) return result;
    if (info.isTextCard && info.resolutionSource !== 'native-file-reader') {
        return { status: 'unsupported', reason: 'text-card-layout' };
    }
    if (info.inputFormat && !['standard', 'raw'].includes(info.inputFormat)) {
        return { status: 'unsupported', reason: 'free-format-data' };
    }
    // Raw read ranges follow the title's length; headers need a stable, complete label.
    const card = info.inputFormat === 'raw' && info.card.length === 1 && info.card[0].t === 'string'
        ? [{ ...info.card[0], p: 0, w: 80 }] : info.card;
    return { ...result, cardInfo: { ...info, card } };
}

export function generateCommentLine(card, style = 'dollar-hash-fixed', labelCase = 'lower') {
    if (!Array.isArray(card) || card.length === 0) return '';
    const fields = card.map(field => ({ name: field?.n, position: Number(field?.p), width: Number(field?.w) }));
    if (!safeRecordGeometry(fields, true)) return '';
    const maximumEnd = fields.reduce((maximum, field) => Math.max(maximum, field.position + field.width), 0);
    const marker = style === 'dollar-hash-fixed' ? '$#' : '$';
    if (fields.length === 1 && fields[0].width > 80) {
        const name = String(fields[0].name || '');
        const casedName = labelCase === 'upper' ? name.toUpperCase() : name.toLowerCase();
        return `${marker} ${casedName.substring(0, fields[0].position + fields[0].width - marker.length - 1)}`;
    }
    if (fields.some((field, index) => fields.slice(index + 1).some(other =>
        Math.max(field.position, other.position) < Math.min(field.position + field.width, other.position + other.width)))) {
        return marker + ' ' + fields.map(field => {
            const name = labelCase === 'upper' ? String(field.name).toUpperCase() : String(field.name).toLowerCase();
            return `${name} [${field.position + 1}-${field.position + field.width}]`;
        }).join(' | ');
    }
    const characters = Array(maximumEnd).fill(' ');
    characters[0] = '$';
    if (marker.length === 2 && maximumEnd > 1) characters[1] = '#';

    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const start = f.position;
        const width = f.width;
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

        const rawName = String(f.name || '');
        const casedName = labelCase === 'upper' ? rawName.toUpperCase() : rawName.toLowerCase();
        const name = casedName.substring(0, available);
        const nameStart = width >= 40
            ? contentStart
            : contentEnd - name.length;
        for (let offset = 0; offset < name.length; offset++) {
            characters[nameStart + offset] = name[offset];
        }
    }
    return characters.join('');
}

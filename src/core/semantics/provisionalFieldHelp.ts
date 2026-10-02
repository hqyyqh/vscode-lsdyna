/**
 * Small, presentation-only field help fallback.
 *
 * This resolver deliberately never grants semantic/runtime authority.  It only
 * makes a field useful in an editor when the strict manual description is not
 * available.  Every non-strict result is marked provisional by the caller.
 */

export type ProvisionalFieldHelpSource =
    | 'strict'
    | 'relaxed-model'
    | 'manual-context'
    | 'lspp-schema'
    | 'field-name';

export type ProvisionalFieldHelpResult = {
    text: string;
    source: ProvisionalFieldHelpSource;
    provisional: boolean;
    identity: string;
};

export type ProvisionalFieldHelpInput = {
    language?: string;
    field?: any;
    strictText?: unknown;
    relaxedText?: unknown;
    relaxedRecord?: any;
    manualContext?: unknown;
    schemaText?: unknown;
    fieldName?: unknown;
    keyword?: unknown;
    cardIndex?: unknown;
    fieldIndex?: unknown;
};

function nonEmpty(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizedKeyword(value: unknown): string {
    const text = String(value || '').trim().toUpperCase();
    return text ? (text.startsWith('*') ? text : `*${text}`) : '';
}

function normalizedFieldName(input: ProvisionalFieldHelpInput): string {
    return String(
        input.fieldName ?? input.field?.n ?? input.relaxedRecord?.fieldNameNormalized ?? 'field',
    ).trim().toUpperCase() || 'FIELD';
}

function fieldType(input: ProvisionalFieldHelpInput): string {
    return String(input.field?.t || input.field?.type || '').trim();
}

function fieldGeometry(input: ProvisionalFieldHelpInput): string {
    const position = Number(input.field?.p ?? input.field?.position);
    const width = Number(input.field?.w ?? input.field?.width);
    if (Number.isInteger(position) && Number.isInteger(width) && width > 0) {
        return input.language === 'zh-cn'
            ? `第 ${position + 1}—${position + width} 列`
            : `columns ${position + 1}-${position + width}`;
    }
    return '';
}

function contextText(value: unknown): string {
    if (typeof value === 'string') return nonEmpty(value);
    if (!value || typeof value !== 'object') return '';
    const object = value as Record<string, unknown>;
    const direct = ['text', 'description', 'summary', 'manualText', 'title']
        .map(key => nonEmpty(object[key]))
        .find(Boolean);
    if (direct) return direct;
    const labels = ['manualLabel', 'manualId', 'sectionId', 'sectionTitle', 'page', 'pdfPage']
        .map(key => nonEmpty(object[key]))
        .filter(Boolean);
    return labels.join(' · ');
}

function identityPrefix(source: ProvisionalFieldHelpSource, input: ProvisionalFieldHelpInput): string {
    const fieldName = normalizedFieldName(input);
    const keyword = normalizedKeyword(input.keyword).replace(/^\*/, '');
    const card = Number.isInteger(input.cardIndex) ? Number(input.cardIndex) : '';
    const field = Number.isInteger(input.fieldIndex) ? Number(input.fieldIndex) : '';
    const scope = [input.relaxedRecord?.finalPhysicalFieldId || keyword, card, field]
        .filter(value => value !== '')
        .join(':') || 'unknown';
    return `${source}:${scope}:${fieldName}`;
}

function generatedManualContext(input: ProvisionalFieldHelpInput): string {
    const keyword = normalizedKeyword(input.keyword) || '*KEYWORD';
    const card = Number.isInteger(input.cardIndex) ? `Card ${Number(input.cardIndex)}` : 'card';
    const name = normalizedFieldName(input);
    const type = fieldType(input);
    const geometry = fieldGeometry(input);
    if (input.language === 'zh-cn') {
        const cardLabel = Number.isInteger(input.cardIndex) ? `第 ${Number(input.cardIndex)} 张卡片` : '卡片';
        const types = { integer: '整数', real: '实数', float: '浮点数', string: '字符串' };
        const details = [type ? `类型：${types[type] || type}` : '', geometry].filter(Boolean).join('，');
        return `${keyword} ${cardLabel}的字段 ${name}${details ? `（${details}）` : ''}。完整定义请查阅已配置的手册。`;
    }
    const details = [name, type ? `type ${type}` : '', geometry].filter(Boolean).join(', ');
    return `${keyword} ${card} field ${details || name}. See the configured manual context for the full definition.`;
}

/** Resolve the first usable description without changing any strict authority. */
export function resolveProvisionalFieldHelp(input: ProvisionalFieldHelpInput = {}): ProvisionalFieldHelpResult {
    const strict = nonEmpty(input.strictText);
    if (strict) {
        return { text: strict, source: 'strict', provisional: false, identity: identityPrefix('strict', input) };
    }

    const relaxed = nonEmpty(input.relaxedText) || nonEmpty(input.relaxedRecord?.officialDescriptionText);
    if (relaxed) {
        return {
            text: relaxed,
            source: 'relaxed-model',
            provisional: true,
            identity: input.relaxedRecord?.finalPhysicalFieldId || identityPrefix('relaxed-model', input),
        };
    }

    const manual = contextText(input.manualContext);
    if (manual) {
        return { text: manual, source: 'manual-context', provisional: true, identity: identityPrefix('manual-context', input) };
    }

    const schema = nonEmpty(input.schemaText) ||
        nonEmpty(input.field?.lsppDescription) ||
        nonEmpty(input.field?.lsppHelp) ||
        nonEmpty(input.field?.description) ||
        nonEmpty(input.field?.help);
    if (schema) {
        return { text: schema, source: 'lspp-schema', provisional: true, identity: identityPrefix('lspp-schema', input) };
    }

    const name = normalizedFieldName(input);
    return {
        text: generatedManualContext(input),
        source: 'field-name',
        provisional: true,
        identity: identityPrefix('field-name', input) || `field-name:${name}`,
    };
}

module.exports = { resolveProvisionalFieldHelp };

export {};

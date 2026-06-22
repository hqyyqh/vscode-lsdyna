export interface KeywordLineClassification {
    isKeyword: boolean;
    indent: number;
    rawKeyword?: string;
    normalizedKeyword?: string;
    hasLowercase?: boolean;
}

export function classifyKeywordLine(text: string): KeywordLineClassification {
    let index = 0;
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
        index++;
    }

    if (text[index] !== '*') {
        return { isKeyword: false, indent: index };
    }

    let end = index + 1;
    while (end < text.length && !/[\s,]/.test(text[end])) {
        end++;
    }
    const rawKeyword = text.slice(index, end);
    return {
        isKeyword: true,
        indent: index,
        rawKeyword,
        normalizedKeyword: rawKeyword.toUpperCase(),
        hasLowercase: /[a-z]/.test(rawKeyword),
    };
}

export function findKeywordAsterisk(buffer: Buffer, start = 0, end = buffer.length): number {
    let index = Math.max(0, start);
    const limit = Math.min(buffer.length, end);
    while (index < limit) {
        const byte = buffer[index];
        if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) break;
        index++;
    }
    return index < limit && buffer[index] === 0x2a ? index : -1;
}

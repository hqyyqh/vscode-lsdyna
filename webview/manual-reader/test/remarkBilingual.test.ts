import { describe, expect, it } from 'vitest';
import { findMatchSpan, normalizeMatchText, remarkBilingual } from '../src/remarkBilingual';

type Node = { type: string; value?: string; data?: Record<string, unknown>; children?: Node[] };

function runPlugin(tree: Node, pairs: Array<{ primary: string; secondary: string; unitId?: string }>): Node {
    const factory = remarkBilingual as unknown as (options: { sentencePairs: typeof pairs }) => (tree: Node) => void;
    factory({ sentencePairs: pairs })(tree);
    return tree;
}

describe('normalizeMatchText / findMatchSpan', () => {
    it('unifies fullwidth punctuation and whitespace', () => {
        expect(normalizeMatchText('EQ.0：关闭')).toBe(normalizeMatchText('EQ.0: 关闭'));
    });

    it('returns exact spans first and normalized spans when needed', () => {
        const haystack = '静摩擦系数。\n\nEQ.0：关闭（默认）';
        expect(findMatchSpan(haystack, '静摩擦系数。')).toEqual({ index: 0, length: '静摩擦系数。'.length });
        const span = findMatchSpan(haystack, 'EQ.0: 关闭(默认)');
        expect(span).not.toBeNull();
        expect(haystack.slice(span!.index, span!.index + span!.length)).toContain('EQ.0');
        expect(findMatchSpan(haystack, '不存在')).toBeNull();
    });
});

describe('remarkBilingual', () => {
    it('wraps normalized matches in prose and GFM table text', () => {
        const tree: Node = {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [{ type: 'text', value: '静摩擦系数。 还有 EQ.0：关闭。' }],
                },
                {
                    type: 'tableCell',
                    children: [{ type: 'text', value: '默认' }],
                },
            ],
        };
        runPlugin(tree, [
            { primary: '静摩擦系数。', secondary: 'Static coefficient of friction.', unitId: 'u1' },
            { primary: 'EQ.0: 关闭', secondary: 'EQ.0: Off' },
            { primary: '默认', secondary: 'Default' },
        ]);
        const bilingual = JSON.stringify(tree).match(/bilingual-text/g) || [];
        expect(bilingual.length).toBeGreaterThanOrEqual(3);
    });

    it('still skips code and raw html node values', () => {
        const primary = 'This ordinary sentence has a translation.';
        const tree: Node = {
            type: 'root',
            children: [
                { type: 'paragraph', children: [{ type: 'text', value: primary }] },
                { type: 'inlineCode', value: primary },
                { type: 'html', value: `<span>${primary}</span>` },
            ],
        };
        runPlugin(tree, [{ primary, secondary: '译文' }]);
        const dump = JSON.stringify(tree);
        expect((dump.match(/bilingual-text/g) || []).length).toBe(1);
    });

    it('keeps text siblings when a parent also has html children', () => {
        const tree: Node = {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [
                        { type: 'text', value: '前文 默认 后文' },
                        { type: 'html', value: '<br>' },
                    ],
                },
            ],
        };
        runPlugin(tree, [{ primary: '默认', secondary: 'Default' }]);
        expect(JSON.stringify(tree)).toContain('bilingual-text');
    });
});

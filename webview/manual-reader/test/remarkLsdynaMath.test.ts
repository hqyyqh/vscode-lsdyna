import { describe, expect, it } from 'vitest';
import { protectDisplayMath, protectInlineMath, protectLsdynaMathSource } from '../src/remarkLsdynaMath';

describe('protectLsdynaMathSource', () => {
    it('turns $$ blocks with a lone = line into fenced math (no setext trap)', () => {
        const source = [
            'respectively. The matrices are given by',
            '',
            '$$',
            '\\begin{pmatrix} X^{\\prime}_{11} \\\\ X^{\\prime}_{22} \\\\ X^{\\prime}_{12} \\end{pmatrix}',
            '=',
            '\\begin{pmatrix}',
            "L^{\\prime}_{11} & L^{\\prime}_{12} & 0 \\\\",
            "L^{\\prime}_{21} & L^{\\prime}_{22} & 0 \\\\",
            "0 & 0 & L^{\\prime}_{33}",
            '\\end{pmatrix}',
            '\\begin{pmatrix} s_{xx} \\\\ s_{yy} \\\\ s_{xy} \\end{pmatrix},',
            '$$',
            '',
            'next paragraph',
        ].join('\n');

        const out = protectDisplayMath(source);
        expect(out).toContain('```math\n');
        expect(out).toContain('\\begin{pmatrix} X^{\\prime}_{11}');
        expect(out).toContain('\n=\n');
        expect(out).toContain('\n```\n');
        // Opening/closing $$ must be gone so setext cannot fire on the = line.
        expect(out).not.toMatch(/^\$\$/m);
        expect(out).not.toMatch(/\$\$$/m);
        expect(out).toContain('next paragraph');
    });

    it('wraps inline math so underscore subscripts stay inside the expression', () => {
        const source = 'The $X^{\\prime}{}_{i j}$ and $X^{\\prime \\prime}{}_{i}$ are eigenvalues.';
        const out = protectInlineMath(source);
        expect(out).toContain('<code class="math-inline">X^{\\prime}{}_{i j}</code>');
        expect(out).toContain('<code class="math-inline">X^{\\prime \\prime}{}_{i}</code>');
        expect(out).not.toMatch(/\$X/);
    });

    it('does not treat currency-like $ amounts as math', () => {
        expect(protectInlineMath('costs $5 today')).toBe('costs $5 today');
    });

    it('protects display then inline together', () => {
        const source = 'See $a_b$ and\n\n$$\nA\n=\nB\n$$\n';
        const out = protectLsdynaMathSource(source);
        expect(out).toContain('<code class="math-inline">a_b</code>');
        expect(out).toContain('```math\nA\n=\nB\n```');
    });

    it('leaves $ inside non-math fenced code untouched', () => {
        const source = 'before\n\n```text\n$fenced$ and $$\n```\n\nafter $x$\n';
        const out = protectLsdynaMathSource(source);
        expect(out).toContain('```text\n$fenced$ and $$\n```');
        expect(out).toContain('<code class="math-inline">x</code>');
    });
});

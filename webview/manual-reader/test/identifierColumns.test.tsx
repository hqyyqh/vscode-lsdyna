import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { describe, expect, it } from 'vitest';
import { rehypeIdentifierColumns } from '../src/rehypeIdentifierColumns';

describe('manual identifier columns', () => {
    it.each([
        '| PARAMETERS | OPTION | FUNCTION |\n|---|---|---|\n|a1|`ROTATE3NA`|A long explanation|',
        '<table><tr><th>参数</th><th>选项</th><th>说明</th></tr><tr><td>a1</td><td>ROTATE3NA</td><td>A long explanation</td></tr></table>',
    ])('protects the semantic column for both table formats', markdown => {
        const { container } = render(<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeIdentifierColumns]}>{markdown}</ReactMarkdown>);
        const marked = container.querySelectorAll('.reader-identifier-cell');
        expect(marked).toHaveLength(1);
        expect(marked[0]).toHaveTextContent('ROTATE3NA');
        expect(container.querySelector('td:last-child')).not.toHaveClass('reader-identifier-cell');
    });
    it('preserves explicit line breaks without protecting explanatory prose', () => {
        const { container } = render(<ReactMarkdown rehypePlugins={[rehypeRaw, rehypeIdentifierColumns]}>{
            '<table><tr><th>OPTION</th></tr><tr><td>TRANSL<br>ROTATE</td></tr><tr><td>按当前设置选择</td></tr></table>'
        }</ReactMarkdown>);
        expect(container.querySelector('.reader-identifier-cell br')).not.toBeNull();
        expect(container.querySelectorAll('.reader-identifier-cell')).toHaveLength(1);
    });
});

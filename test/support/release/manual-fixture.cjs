'use strict';
const fs = require('node:fs'), path = require('node:path');
function createManualFixture(root) {
    const write = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value); };
    write('manifest.json', { schemaVersion: 2, generatedAt: 'release-test', documents: [{ slug: 'vol', title: 'Release test manual', order: 1 }] });
    const sections = ['formula', 'next'].map((id, index) => ({ manualId: 'vol', sectionId: id, level: 1,
        titleEn: id === 'formula' ? 'Compression formula' : 'Next section', titleZh: id === 'formula' ? '压缩验证公式' : '下一节',
        anchors: [id], pathEn: `documents/en/vol/chunks/${id}.md`, pathZh: `documents/zh/vol/chunks/${id}.md`, pdfPage: index + 1 }));
    write('indexes/sections.json', { schemaVersion: 1, sections });
    write('indexes/keywords.json', { schemaVersion: 1, keywords: { '*NODE': { manualId: 'vol', sectionId: 'formula', anchorId: 'formula', pdfPage: 1 } } });
    write('indexes/anchors.json', { schemaVersion: 1, anchors: { formula: { manualId: 'vol', sectionId: 'formula' }, next: { manualId: 'vol', sectionId: 'next' } } });
    write('indexes/sentence-map.json', { schemaVersion: 1, sentences: [] });
    for (const language of ['en', 'zh']) {
        write(`indexes/search-${language}.json`, { schemaVersion: 1, docs: sections.map(section => ({ ...section, keywords: ['*NODE'], preview: 'release-formula' })) });
        const introduction = language === 'zh' ? '离线图片与公式。' : 'Offline image and equation.';
        write(`documents/${language}/vol/chunks/formula.md`, '<a id="formula"></a>\n# release-formula\n\n' + introduction + '\n\n$$\n\\mathbb{R}+\\mathcal{F}+\\mathfrak{g}+\\mathbf{ABC}+\\mathsf{xyz}+\\mathtt{012}+\\boldsymbol{\\alpha}+\\left(\\frac{\\sqrt{1+x^2}}{\\sum_{i=1}^{n}x_i}\\right)\n$$\n\n![sample](../assets/sample.png)\n');
        write(`documents/${language}/vol/chunks/next.md`, '<a id="next"></a>\n# release-next\n\nSecond section.\n');
        write(`documents/${language}/vol/assets/sample.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=', 'base64'));
    }
}
module.exports = { createManualFixture };

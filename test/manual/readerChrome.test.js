'use strict';

const assert = require('assert');
const {
    formatReaderChromeCrumb,
    readerChromeIdentity,
} = require('../../src/manual/readerChrome');

describe('readerChrome', () => {
    const documents = [
        { manualId: 'vol-i', title: 'Volume I' },
        { manualId: 'vol-ii', title: 'Volume II' },
    ];
    const sections = [
        {
            sectionId: 'contact-home',
            titleEn: '*CONTACT',
            pathEn: 'documents/en/vol-i/chunks/12_contact/12_00_contact.md',
        },
        {
            sectionId: 'card-2',
            titleEn: 'Mandatory Card 2',
            pathEn: 'documents/en/vol-i/chunks/12_contact/12_08_mandatory-card-2.md',
        },
        {
            sectionId: 'node',
            titleEn: 'Node',
            pathEn: 'documents/en/vol-i/chunks/06_boundary/06_01_node.md',
        },
    ];

    it('resolves volume title and chapter label from documents and section paths', () => {
        const chrome = readerChromeIdentity(documents, sections, {
            manualId: 'vol-i',
            sectionId: 'card-2',
        });
        assert.equal(chrome.volumeTitle, 'Volume I');
        assert.equal(chrome.chapterKey, '12_contact');
        assert.equal(chrome.chapterLabel, '*CONTACT');
        assert.equal(formatReaderChromeCrumb(chrome), 'Volume I · *CONTACT');
    });

    it('falls back to manualId when the document is missing', () => {
        const chrome = readerChromeIdentity([], sections, {
            manualId: 'vol-x',
            sectionId: 'node',
        });
        assert.equal(chrome.volumeTitle, 'vol-x');
        assert.equal(chrome.chapterKey, '06_boundary');
        assert.equal(chrome.chapterLabel, 'Node');
    });

    it('returns empty chapter when section is not found', () => {
        const chrome = readerChromeIdentity(documents, sections, {
            manualId: 'vol-i',
            sectionId: 'missing',
        });
        assert.equal(chrome.volumeTitle, 'Volume I');
        assert.equal(chrome.chapterKey, null);
        assert.equal(chrome.chapterLabel, '');
        assert.equal(formatReaderChromeCrumb(chrome), 'Volume I');
    });
});

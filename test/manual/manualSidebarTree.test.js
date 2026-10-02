'use strict';

const assert = require('assert');
const {
    ROOT_CHAPTER_KEY,
    buildChapterGroups,
    chapterKeyFromPath,
    chapterLabel,
    findChapterKeyForSection,
    prettifyChapterKey,
} = require('../../src/manual/manualSidebarTree');

describe('manualSidebarTree', () => {
    it('extracts chapter keys from pack paths', () => {
        assert.equal(
            chapterKeyFromPath('documents/en/vol-i/chunks/12_contact/12_08_mandatory-card-2.md'),
            '12_contact',
        );
        assert.equal(
            chapterKeyFromPath('documents\\en\\vol-i\\chunks\\04_airbag\\x.md'),
            '04_airbag',
        );
        assert.equal(chapterKeyFromPath('documents/en/vol-i/chunks/node.md'), ROOT_CHAPTER_KEY);
        assert.equal(chapterKeyFromPath(''), ROOT_CHAPTER_KEY);
    });

    it('prettifies folder keys and labels chapters from the first section title', () => {
        assert.equal(prettifyChapterKey('12_contact'), '12 Contact');
        assert.equal(prettifyChapterKey('00_front_matter'), '00 Front Matter');
        assert.equal(prettifyChapterKey(ROOT_CHAPTER_KEY), 'Sections');
        assert.equal(
            chapterLabel('12_contact', [{ sectionId: 'a', titleEn: '*CONTACT', pathEn: 'x' }]),
            '*CONTACT',
        );
        assert.equal(chapterLabel('12_contact', []), '12 Contact');
    });

    it('groups sections in repository order without re-sorting chapters alphabetically', () => {
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
                sectionId: 'control-home',
                titleEn: '*CONTROL',
                pathEn: 'documents/en/vol-i/chunks/13_control/13_00_control.md',
            },
        ];
        const groups = buildChapterGroups(sections);
        assert.deepStrictEqual(groups.map(g => g.key), ['12_contact', '13_control']);
        assert.equal(groups[0].label, '*CONTACT');
        assert.equal(groups[0].sections.length, 2);
        assert.equal(groups[1].label, '*CONTROL');
        assert.equal(findChapterKeyForSection(groups, 'card-2'), '12_contact');
        assert.equal(findChapterKeyForSection(groups, 'missing'), null);
    });
});

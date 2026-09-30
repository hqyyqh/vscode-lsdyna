'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
require('./register-out');
const vscode = require('vscode'), { fakeDoc } = require('./helpers');
const extension = require('../out/extension')._internals;
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('./fixtures/public-behavior/fixed-comma-blank.json.gz'))));
function document(lines, name) {
    return Object.assign(fakeDoc(lines.join('\n'), `D:/native-fixed/${name}.k`),
        { languageId: 'lsdyna', isDirty: true, version: 1, uri: vscode.Uri.file(`D:/native-fixed/${name}.k`) });
}
function blankRecord(occurrence) {
    try {
        const target = [...occurrence.queries].reverse().find(item =>
            occurrence.lines.slice(1, item.line).some(line => line.includes(',')) && occurrence.lines[item.line].includes(','));
        assert.ok(target, 'blank comma record has no preceding delimiter-bearing record');
        const beforeDocument = document(occurrence.lines, `${occurrence.identity}-before-blank-comma`);
        const resolved = extension.getCardInfoForDocumentLineWithSuggest(beforeDocument, target.line);
        const before = resolved.cardInfo?.card?.find(candidate => candidate.n.toUpperCase() === target.name.toUpperCase() &&
            candidate.p === target.range.start && candidate.p + candidate.w === target.range.end);
        assert.ok(before, `Native field mismatch in ${beforeDocument.uri.fsPath} at ${target.line}:${target.range.start} (${target.name}); ${resolved.reason || ''}`);
        assert.equal(before.nativeIdentity?.source, fixture.sourceSha256, `${target.name}: native source identity`);
        const lines = [...occurrence.lines]; lines[target.line] = '';
        const afterResolved = extension.getCardInfoForDocumentLineWithSuggest(document(lines, `${occurrence.identity}-blank-comma`), target.line);
        const after = afterResolved.cardInfo?.card?.find(item => item.n === before.n && item.nativeIdentity?.fieldRecordId === before.nativeIdentity.fieldRecordId);
        assert.ok(after, 'blank comma record lost its independently witnessed native field identity');
        assert.deepEqual(after.nativeIdentity, before.nativeIdentity, 'blank comma record borrowed a different branch or instance');
        return { status: 'passed', behavior: 'blank-comma-card-retains-native-identity',
            priorCommaLine: occurrence.lines.slice(1, target.line).findIndex(line => line.includes(',')) + 1, field: target.name };
    } catch (error) { return { status: 'pending', reason: String(error.message || error) }; }
}

describe('blank comma records in native fixed readers', function () {
    this.timeout(30000);
    it('preserves native field identity only when a prior comma record establishes the format', async () => {
        assert.equal(fixture.cases.length, 309);
        const counts = { passed: 0, noContext: 0, unresolved: 0, noQuery: 0 };
        for (const occurrence of fixture.cases) {
            if (occurrence.expected.status === 'no-query') { counts.noQuery++; continue; }
            const result = blankRecord(occurrence);
            assert.deepEqual(result, occurrence.expected, occurrence.identity);
            if (result.status === 'passed') {
                assert.equal(result.behavior, 'blank-comma-card-retains-native-identity');
                assert.ok(result.priorCommaLine > 0);
                counts.passed++;
            } else if (result.reason === 'blank comma record has no preceding delimiter-bearing record')
                counts.noContext++;
            else counts.unresolved++;
        }
        assert.deepEqual(counts, { passed: 213, noContext: 92, unresolved: 1, noQuery: 3 });
    });
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { collectOptionSwitchBlock, buildKeywordOptionViewModel } = require("../../../out/extension")._internals;
const fixture = path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-beam-mixed-instances.k");
const evidence = require("../../fixtures/public-behavior/section-beam-instances.json");
const text = fs.readFileSync(fixture, 'utf8');
const lines = text.split(/\r?\n/);
const document = {
    languageId: 'lsdyna', version: 1, lineCount: lines.length, eol: 1,
    uri: vscode.Uri.file(fixture), lineAt: line => ({ text: lines[line] }),
    getText: () => text,
};

describe('native SECTION_BEAM mixed instance fixture', () => {
    it('preserves the exact native export including the last empty YS record', () => {
        assert.equal(lines.filter(line => line === '*SECTION_BEAM').length, 1);
        assert.deepEqual(evidence.observedInstances.map(item => lines[item.sourceDataLines[0]].split(',')[0]),
            ['101', '102', '112']);
        assert.equal(lines[17], '');
        assert.equal(lines[18], '*END');
    });

    it('collects the empty final native card as source data', () => {
        const block = collectOptionSwitchBlock(document, 3, {});
        assert.equal(block.records.length, 7);
        assert.equal(block.records[6].text, '');
    });

    it('selects all three native instances under the single keyword header', () => {
        for (const item of evidence.observedInstances) {
            const line = item.sourceDataLines[0];
            const model = buildKeywordOptionViewModel({ document,
                selection: { active: new vscode.Position(line, 0) } }, line, {});
            const instances = model.managerInstances.filter(candidate => candidate.keyword === '*SECTION_BEAM');
            assert.equal(instances.length, 3);
            assert.equal(model.managerCards.length, item.nativeCards.length);
            assert.equal(model.managerCards[0].fields.find(field => field.name === 'SECID').value, String(item.secid));
        }
    });
});

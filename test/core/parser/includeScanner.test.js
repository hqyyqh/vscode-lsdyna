'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectIncludeDirectivesFromFile } = require('../../../src/core/parser/includeScanner');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'Bolt_A_Explicit');

describe('includeScanner', () => {
    it('streams include directives from a real fixture file', async () => {
        const fixturePath = path.join(FIXTURE_DIR, 'mainboltaexpl.k');

        const result = await collectIncludeDirectivesFromFile(fixturePath);

        const names = result.includeEntries.map(entry => entry.fileName);
        assert.ok(names.includes('includes.k'));
        assert.ok(names.includes('material_props.k'));
        assert.ok(names.includes('missing_geometry.k'));
        assert.ok(result.searchPaths.includes(path.join(FIXTURE_DIR, 'submodels')));
    });

    it('preserves continued include filenames and segments when scanning files', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-scanner-'));
        const filePath = path.join(tempDir, 'continued.k');

        fs.writeFileSync(filePath, '*INCLUDE\npart_a +\npart_b.key\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.equal(result.includeEntries.length, 1);
        assert.equal(result.includeEntries[0].fileName, 'part_apart_b.key');
        assert.equal(result.includeEntries[0].segments.length, 2);
    });
});

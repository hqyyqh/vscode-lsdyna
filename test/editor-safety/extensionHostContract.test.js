'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('editor safety Extension Host contract', () => {
    const sourcePath = path.resolve(
        __dirname,
        'extension-host',
        'index.js',
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    it('keeps every focused scenario in the default full run', () => {
        const focusedBlock = source.match(
            /const scenarios = \{([\s\S]*?)\n\s*\};/,
        );
        const fullRunBlock = source.match(
            /await assertPassiveOperationsDoNotWrite\(\);([\s\S]*?)\n\s*await vscode\.commands\.executeCommand\('workbench\.action\.closeAllEditors'\);/,
        );
        assert.ok(focusedBlock, 'focused scenario registry must be present');
        assert.ok(fullRunBlock, 'default full-run sequence must be present');

        const focusedFunctions = [
            ...focusedBlock[1].matchAll(/:\s*(assert[A-Za-z0-9_]+),/g),
        ].map(match => match[1]);
        assert.ok(focusedFunctions.length > 0, 'focused scenario registry must not be empty');

        const omitted = focusedFunctions.filter(
            functionName => !fullRunBlock[0].includes(`await ${functionName}();`),
        );
        assert.deepStrictEqual(
            omitted,
            [],
            `focused scenarios omitted from the default run: ${omitted.join(', ')}`,
        );
    });

    it('reports the number of scenarios actually invoked by the full run', () => {
        const fullRunBlock = source.match(
            /await assertPassiveOperationsDoNotWrite\(\);([\s\S]*?)\n\s*await vscode\.commands\.executeCommand\('workbench\.action\.closeAllEditors'\);/,
        );
        const reportedCount = source.match(
            /Editor safety Extension Host: (\d+) scenarios passed/,
        );
        assert.ok(fullRunBlock, 'default full-run sequence must be present');
        assert.ok(reportedCount, 'full-run scenario count must be reported');

        const invokedCount = (
            fullRunBlock[0].match(/await assert[A-Za-z0-9_]+\(\);/g) || []
        ).length;
        assert.strictEqual(Number(reportedCount[1]), invokedCount);
    });
});

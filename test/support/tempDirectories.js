'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Call at suite registration, so failed assertions also release every fixture.
function trackTempDirectories() {
    const roots = new Set();
    afterEach(() => {
        const errors = [];
        for (const root of roots) {
            try {
                assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
                fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                assert.equal(fs.existsSync(root), false, `Temporary fixture remains: ${root}`);
                roots.delete(root);
            } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Temporary fixture cleanup failed');
    });
    return prefix => {
        assert.equal(path.dirname(path.resolve(prefix)), path.resolve(os.tmpdir()));
        const root = fs.mkdtempSync(prefix);
        roots.add(root);
        return root;
    };
}
module.exports = { trackTempDirectories };

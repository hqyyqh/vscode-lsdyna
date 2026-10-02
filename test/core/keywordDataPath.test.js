const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

function resolver(stageExists) {
    let checks = 0;
    const compiled = path.resolve(__dirname, '../../out/core/keywordDataPath.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(compiled, 'utf8'), {
        exports: module.exports, module, __dirname: path.dirname(compiled),
        require(name) {
            if (name === 'fs') return { existsSync() { checks++; return stageExists; } };
            return require(name);
        },
    }, { filename: compiled });
    return { ...module.exports, checks: () => checks };
}

describe('keyword runtime data root', () => {
    it('selects the generated development stage once for all runtime callers', () => {
        const data = resolver(true);
        for (const file of ['schema/field_data.json', 'engineering/keywordLayoutCorrections.json',
            'native-help/manifest.json', 'input-form/manifest.json']) {
            assert.ok(data.keywordDataPath(file).includes(path.join('out', 'data-build', 'keywords', 'runtime')));
        }
        assert.equal(data.checks(), 1);
    });

    it('uses packaged runtime resources when no development stage is present', () => {
        const data = resolver(false);
        assert.ok(data.keywordDataPath('schema/field_data.json').endsWith(path.join('keywords', 'runtime', 'schema', 'field_data.json')));
        assert.ok(!data.keywordDataPath('input-form/manifest.json').includes('data-build'));
        assert.equal(data.checks(), 1);
    });

    it('keeps explicit temporary compiler inputs independent of the cached product root', () => {
        const data = resolver(true);
        const product = data.keywordDataPath('schema/field_data.json');
        const temporary = path.resolve('temporary-compiler', 'keywords', 'runtime');
        data.setKeywordDataRootForBuild(temporary);
        assert.equal(data.keywordDataPath('schema/field_data.json'), path.join(temporary, 'schema/field_data.json'));
        data.setKeywordDataRootForBuild();
        assert.equal(data.keywordDataPath('schema/field_data.json'), product);
        assert.equal(data.checks(), 1);
    });
});


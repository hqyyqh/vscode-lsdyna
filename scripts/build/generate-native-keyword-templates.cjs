'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { nativeKeywordTemplate } = require("../../out/core/completion/nativeKeywordTemplate");
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function generate(snippets) {
    const output = {}, entries = [];
    for (const [key, snippet] of Object.entries(snippets)) {
        const result = nativeKeywordTemplate(key);
        const { body, ...evidence } = result;
        const next = result.status === 'rejected-spelling' ? null : body ? { ...snippet, body } : snippet;
        if (next) output[key] = next;
        entries.push({ keyword: key, ...evidence, changed: JSON.stringify(next) !== JSON.stringify(snippet),
            beforeSha256: hash(JSON.stringify(snippet)), afterSha256: next ? hash(JSON.stringify(next)) : null });
    }
    return { snippets: output, report: { scope: 'verified native layouts; retained templates are not native-verified',
        entries, counts: entries.reduce((counts, entry) => {
            counts[entry.status] = (counts[entry.status] || 0) + 1;
            return counts;
        }, {}) } };
}
if (require.main === module) {
    const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, report: { type: 'string' } } });
    if (!values.input || !values.output) throw new Error('--input and --output are required');
    const result = generate(JSON.parse(fs.readFileSync(values.input, 'utf8')));
    fs.writeFileSync(values.output, JSON.stringify(result.snippets, null, 2) + '\n');
    if (values.report) fs.writeFileSync(values.report, JSON.stringify(result.report, null, 2) + '\n');
    console.log(JSON.stringify(result.report.counts));
}
module.exports = { generate };

'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ts = require('typescript');
const { releasePath } = require('./release-resource-paths.cjs');

function prepareReleaseMetadata(stage, { renameResources = true } = {}) {
    const manifestPath = path.join(stage, 'out/runtime/lspp-input-form/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    // These three fields have no runtime consumers. Version and hashes still bind verified readers.
    const removedProducer = {};
    const dataset = manifest.dataset || manifest.dataset;
    assert.ok(dataset, 'Missing verified catalog binding');
    for (const key of ['name', 'authority', 'executable']) {
        if (Object.hasOwn(dataset, key)) removedProducer[key] = dataset[key];
        delete dataset[key];
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const referencePath = path.join(stage, "keywords/runtime/references/field_reference_index.json");
    if (fs.existsSync(referencePath)) {
        const reference = JSON.parse(fs.readFileSync(referencePath));
        if (renameResources && reference.lsppBlockedReferences?.file)
            reference.lsppBlockedReferences.file = releasePath(reference.lsppBlockedReferences.file);
        fs.writeFileSync(referencePath, JSON.stringify(reference));
    }
    const categoryPath = path.join(stage, "keywords/runtime/categories/lspp_keyword_categories.runtime.json");
    if (fs.existsSync(categoryPath)) {
        const category = JSON.parse(fs.readFileSync(categoryPath));
        if (category.source) {
            delete category.source.datasetVersion;
            delete category.source.datasetSha256;
        }
        fs.writeFileSync(categoryPath, JSON.stringify(category));
    }
    const packagePath = path.join(stage, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath));
    delete pkg.scripts; delete pkg.devDependencies;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
    if (!renameResources) return { removedProducer, renamed: [] };
    const renamed = [];
    const components = new Set();
    function collect(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            if (releasePath(item.name) !== item.name) {
                components.add(item.name);
                if (item.name.endsWith('.js')) components.add(item.name.slice(0, -3));
            }
            if (item.isDirectory()) collect(path.join(directory, item.name));
        }
    }
    collect(path.join(stage, 'out')); collect(path.join(stage, 'keywords'));
    const resourceLiteral = value => value.split(/([/\\])/).map(part => components.has(part) ? releasePath(part) : part).join('');
    function visit(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name);
            if (item.isDirectory()) visit(file);
            else if (file.endsWith('.js') && !file.includes(`${path.sep}webview${path.sep}`)) {
                const original = fs.readFileSync(file, 'utf8');
                const tree = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                const edits = [];
                const walk = node => {
                    if (ts.isStringLiteral(node) && resourceLiteral(node.text) !== node.text)
                        edits.push({ start: node.getStart(tree), end: node.end, text: JSON.stringify(resourceLiteral(node.text)) });
                    ts.forEachChild(node, walk);
                };
                walk(tree);
                let next = original;
                for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
                if (next !== original) fs.writeFileSync(file, next);
            }
            const renamedBase = releasePath(item.name);
            if (renamedBase !== item.name) {
                const target = path.join(directory, renamedBase);
                assert.ok(!fs.existsSync(target), `Release resource collision: ${target}`);
                fs.renameSync(file, target);
                renamed.push(path.relative(stage, file).replace(/\\/g, '/'));
            }
        }
    }
    visit(path.join(stage, 'out')); visit(path.join(stage, 'keywords'));
    const ignorePath = path.join(stage, '.vscodeignore');
    fs.writeFileSync(ignorePath, releasePath(fs.readFileSync(ignorePath, 'utf8')));
    return { removedProducer, renamed };
}
module.exports = { prepareReleaseMetadata };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ts = require('typescript');
const PRIVATE_PATH = /[A-Za-z]:[\\/]+(?:Users[\\/]+(?!test(?:er)?(?:[\\/]|$)|example(?:[\\/]|$)|user(?:[\\/]|$))[^\\/]+|Project[\\/]+(?:vscode-lsdyna|LSPP_database|LSDYNA_Manual_Build))|(?:out[\\/]+remaining-lspp|lspp-keyword-database(?:[\\/]+normalized)?)/i;
const PRODUCER_POINTER = /(?:extract[_-](?:lspp|native)[\w-]*\.(?:py|cjs)|(?:scripts|tools)[\\/]+(?:analy[sz]e-native|extract-native|dynamic-hover-oracle)[\w-]*\.(?:py|cjs)|docs[\\/]+lspp-native-[^\s"']+\.gz|test[\\/]+fixtures[\\/]+lspp-native(?:-formats[\\/]+provenance\.json|[\\/]+[^\s"']+\.(?:gz|jsonl)))/i;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/(?!\/)|[\\/]{2}|file:\/\/\/)/;
const PRODUCTION_PATH_KEY = /(?:^|\.)(?:source|evidence|inputs?|exporter|extractor|producer|parser|dependencies|archive|oracle|proof)[^.]*\.(?:[^.]+\.)*(?:path|file|directory|root|executable)$/i;

function scanPublicSourceBoundary(root, files, { readFile = file => fs.readFileSync(path.join(root, file)) } = {}) {
    root = path.resolve(root);
    const findings = [], exceptions = [];
    const check = (file, location, value) => {
        const registrySourceIdentity = 'lspp-keyword-database/normalized/link_census/authoring_semantic_handoff';
        if (value === registrySourceIdentity && (
            file === 'keywords/sources/definition-registry/authoring.json.gz' && location === '$.authorityLock.source.repositoryPath' ||
            file === 'scripts/build/generate-definition-registry.cjs' && location.startsWith('string:'))) {
            exceptions.push({ file, location, reason: 'required-exact-relative-upstream-source-identity' });
            return;
        }
        if (!PRIVATE_PATH.test(value) && !PRODUCER_POINTER.test(value) &&
            !(location.startsWith('$.') && PRODUCTION_PATH_KEY.test(location) && ABSOLUTE_PATH.test(value))) return;
        if (["scripts/maintenance/validate-project-contracts.cjs", "scripts/release/validate-package-contents.cjs",
            "test/scripts/release/validatePackageContents.test.js"].includes(file) &&
            !PRIVATE_PATH.test(value)) {
            exceptions.push({ file, location, reason: 'forbidden-package-path-policy-or-its-synthetic-test' }); return;
        }
        if (file === "test/scripts/release/releaseMetadata.test.js" && value === 'extract_lspp.py') {
            exceptions.push({ file, location, reason: 'synthetic-producer-name-tests-metadata-removal' }); return;
        }
        findings.push({ file, location, value });
    };
    for (const file of files) {
        if (file === "scripts/release/validate-public-source-boundary.cjs") continue;
        if (!/\.(?:json|gz|br|[cm]?js|tsx?|py|md|k|txt|html|css|cpp|jsonl|log|ya?ml|toml)$/.test(file) && !/(?:^|\/)LICENSE(?:\.[^/]+)?$/.test(file)) continue;
        let bytes = readFile(file);
        if (file.endsWith('.gz')) bytes = zlib.gunzipSync(bytes);
        if (file.endsWith('.br')) bytes = zlib.brotliDecompressSync(bytes);
        const text = bytes.toString('utf8');
        if (/\.(?:json|gz|br)$/.test(file)) {
            const walk = (value, location) => {
                if (typeof value === 'string') check(file, location, value);
                else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value))
                    walk(child, `${location}.${key}`);
            };
            let value;
            try { value = JSON.parse(text); }
            catch (error) {
                if (/\.(?:gz|br)$/.test(file) || file.startsWith('keywords/')) throw error;
                const parsed = ts.parseConfigFileTextToJson(file, text);
                if (parsed.error) throw Error(`Cannot parse boundary input: ${file}`);
                value = parsed.config;
            }
            walk(value, '$');
        } else if (/\.(?:[cm]?js|tsx?)$/.test(file)) {
            const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), comments = new Map();
            const walk = node => {
                if (ts.isStringLiteralLike(node)) check(file, `string:${node.getStart(tree)}`, node.text);
                for (const range of [...(ts.getLeadingCommentRanges(text, node.getFullStart()) || []),
                    ...(ts.getTrailingCommentRanges(text, node.end) || [])]) comments.set(range.pos, range);
                ts.forEachChild(node, walk);
            };
            walk(tree);
            for (const range of comments.values()) check(file, `comment:${range.pos}`, text.slice(range.pos, range.end));
        } else text.split(/\r?\n/).forEach((line, index) => check(file, `line:${index + 1}`, line));
    }
    return { checkedFiles: files.length, findings, exceptions };
}

function validatePublicSourceBoundary(root) {
    // Scan current contributions too; a stale manifest cannot hide newly added source.
    const files = require('./update-source-manifest.cjs').inventory(root);
    const visit = relative => {
        if (!fs.existsSync(path.join(root, relative))) return;
        for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const child = `${relative}/${item.name}`;
            if (item.isDirectory()) visit(child); else files.push(child);
        }
    };
    for (const directory of ['core', 'runtime', 'client', 'server', 'shared', 'worker', 'manual', 'platform', 'webview'])
        visit('out/' + directory);
    if (fs.existsSync(path.join(root, 'out/extension.js'))) files.push('out/extension.js');
    const result = scanPublicSourceBoundary(root, [...new Set(files)]);
    if (result.findings.length) throw Error(`Public boundary contains ${result.findings.length} private production references: ` +
        result.findings.slice(0, 12).map(item => `${item.file}#${item.location}`).join(', '));
    return result;
}
module.exports = { scanPublicSourceBoundary, validatePublicSourceBoundary };
if (require.main === module) {
    try { const result = validatePublicSourceBoundary(process.cwd());
        console.log(JSON.stringify({ checkedFiles: result.checkedFiles, blockedReferences: 0, necessaryExceptionCount: result.exceptions.length }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

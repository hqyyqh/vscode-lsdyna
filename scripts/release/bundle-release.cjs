'use strict';
const fs = require('node:fs'), path = require('node:path');
const esbuild = require('esbuild'), ts = require('typescript');

async function bundleRelease(stage) {
    // esbuild resolves source symlinks; use the same root for relative resource paths.
    stage = fs.realpathSync(stage);
    const entries = ['out/extension.js', 'out/server/server.js', 'out/worker/scanWorker.js'];
    const inputs = new Set(), outputs = new Map(), reports = {}, externalFiles = new Set();
    for (const entry of entries) {
        const outdir = path.dirname(path.join(stage, entry));
        const result = await esbuild.build({ absWorkingDir: stage, entryPoints: [entry],
            outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
            external: ['vscode'], minify: true, keepNames: true, sourcemap: false, legalComments: 'inline',
            write: false, metafile: true, plugins: [{ name: 'preserve-module-resource-paths', setup(build) {
                build.onResolve({ filter: /\.json$/ }, args => {
                    if (!args.path.startsWith('.')) return;
                    const file = path.resolve(args.resolveDir, args.path);
                    return { path: './' + path.relative(outdir, file).replace(/\\/g, '/'), external: true };
                });
                build.onLoad({ filter: /\.[cm]?js$/ }, args => {
                    const source = fs.readFileSync(args.path, 'utf8');
                    const tree = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                    const transformed = ts.transform(tree, [context => {
                        const visit = node => {
                            if (ts.isIdentifier(node) && ['__dirname', '__filename'].includes(node.text)) {
                                const target = node.text === '__dirname' ? path.dirname(args.path) : args.path;
                                return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
                                    ts.factory.createCallExpression(ts.factory.createIdentifier('require'), undefined,
                                        [ts.factory.createStringLiteral('node:path')]), 'resolve'), undefined,
                                    [ts.factory.createIdentifier('__dirname'), ts.factory.createStringLiteral(path.relative(outdir, target).replace(/\\/g, '/'))]);
                            }
                            return ts.visitEachChild(node, visit, context);
                        };
                        return file => ts.visitNode(file, visit);
                    }]);
                    try { return { contents: ts.createPrinter().printFile(transformed.transformed[0]), loader: 'js', resolveDir: path.dirname(args.path) }; }
                    finally { transformed.dispose(); }
                });
            } }] });
        for (const file of Object.keys(result.metafile.inputs)) inputs.add(file);
        for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) {
            if (item.path.startsWith('.')) externalFiles.add(path.resolve(outdir, item.path));
            else if (item.path !== 'vscode' && !require('node:module').isBuiltin(item.path))
                throw Error(`Undeclared external bundle dependency: ${item.path}`);
        }
        outputs.set(entry, result.outputFiles[0].contents);
        reports[entry] = result.metafile;
    }
    // Production JS is the closure of the three declared entrypoints. Stale compiled
    // modules outside this closure must not retain imports to removed modules.
    const prune = directory => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name), relative = path.relative(stage, file).replace(/\\/g, '/');
            if (relative.startsWith('out/webview') || relative.startsWith('out/runtime')) continue;
            if (item.isDirectory()) prune(file);
            else if (file.endsWith('.js') && !entries.includes(relative)) fs.unlinkSync(file);
        }
    };
    prune(path.join(stage, 'out'));
    const pruneDependencies = directory => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name);
            if (item.isDirectory()) pruneDependencies(file);
            else if (!externalFiles.has(file) && item.name !== 'package.json' &&
                !/^(licen[cs]e|notice|copyright|copying)(\.|$|-)/i.test(item.name)) fs.unlinkSync(file);
        }
    };
    pruneDependencies(path.join(stage, 'node_modules'));
    for (const [file, bytes] of outputs) fs.writeFileSync(path.join(stage, file), bytes);
    const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(stage, 'out/runtime/release-code.json'), JSON.stringify({ schemaVersion: 1,
        entries: Object.fromEntries([...outputs].map(([file, bytes]) => [file, sha(bytes)])) }));
    fs.appendFileSync(path.join(stage, '.vscodeignore'), '\n!out/runtime/release-code.json\n');
    return reports;
}
module.exports = { bundleRelease };

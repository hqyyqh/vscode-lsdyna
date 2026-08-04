'use strict';

const fs = require('fs');
const path = require('path');

const { snapshotDirectory } = require('../test/editor-safety/fileOracle');

function parseArguments(argv) {
    const args = { root: null, output: null };
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--output') {
            args.output = argv[++index];
        } else if (!args.root) {
            args.root = value;
        } else {
            throw new Error(`Unexpected argument: ${value}`);
        }
    }
    if (!args.root) {
        throw new Error('Usage: node scripts/editor-safety-baseline.cjs <root> [--output <snapshot.json>]');
    }
    if (args.output === undefined) {
        throw new Error('--output requires a file path');
    }
    return args;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const snapshot = await snapshotDirectory(args.root);
    const result = {
        capturedAt: startedAt,
        elapsedMs: Date.now() - started,
        ...snapshot,
    };

    if (args.output) {
        const output = path.resolve(args.output);
        if (fs.existsSync(output)) {
            throw new Error(`Refusing to overwrite existing snapshot: ${output}`);
        }
        await fs.promises.mkdir(path.dirname(output), { recursive: true });
        await fs.promises.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }

    process.stdout.write(`${JSON.stringify({
        root: result.root,
        capturedAt: result.capturedAt,
        elapsedMs: result.elapsedMs,
        ...result.summary,
        output: args.output ? path.resolve(args.output) : null,
    }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
});

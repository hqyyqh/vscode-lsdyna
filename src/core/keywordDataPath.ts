import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');
let buildRoot: string | undefined;
let runtimeRoot: string | undefined;

/** Pure data compilers select their own temporary inputs, independent of previous builds. */
export function setKeywordDataRootForBuild(directory?: string): void {
    buildRoot = directory;
}

/** Development builds consume their generated stage; installed packages consume packaged data. */
export function keywordDataPath(relative: string): string {
    if (buildRoot) return path.join(buildRoot, relative);
    if (!runtimeRoot) {
        const stage = path.join(root, 'out', 'data-build', 'keywords');
        runtimeRoot = fs.existsSync(path.join(stage, 'provenance', 'current-data.json'))
            ? path.join(stage, 'runtime') : path.join(root, 'keywords', 'runtime');
    }
    return path.join(runtimeRoot, relative);
}

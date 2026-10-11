import * as fs from 'node:fs';
import * as path from 'node:path';

/** Stat identity is checked before and after a build, and again on each restored query. */
export async function entityFileRevision(file: string): Promise<string> {
    const real = await fs.promises.realpath(file);
    const stat = await fs.promises.stat(real, { bigint: true });
    if (!stat.isFile()) throw new Error('Entity index source is not a regular file');
    return JSON.stringify([process.platform === 'win32' ? real.toLowerCase() : real,
        stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(),
        stat.ctimeNs.toString(), stat.birthtimeNs.toString()]);
}

export async function entityFileSignature(file: string) {
    const stat = await fs.promises.stat(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, sourceRevision: await entityFileRevision(file) };
}

export async function entityFilesUnchanged(files: { file: string; revision: string }[],
    token?: { isCancellationRequested: boolean }): Promise<boolean> {
    for (let offset = 0; offset < files.length; offset += 8) {
        if (token?.isCancellationRequested) return false;
        const unchanged = await Promise.all(files.slice(offset, offset + 8).map(async file => {
            if (!path.isAbsolute(file.file)) return false;
            try { return await entityFileRevision(file.file) === file.revision; }
            catch { return false; }
        }));
        if (unchanged.includes(false)) return false;
    }
    return token?.isCancellationRequested !== true;
}

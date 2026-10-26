import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

type Piece = { file: string; offset: number; length: number };
export type RecordDraft = { version: number; start: number; end: number; text: string; raw: Buffer; firstLine: number };
const MAX_BYTES = 2 * 1024 * 1024;
export async function hashFile(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

/** Immutable disk pieces retain undo history without retaining whole decks in memory. */
export class LargeFileEditDocument {
    version = 0;
    private pieces: Piece[] | null = null;
    private savedPieces: Piece[] | null = null;
    private sourceHash = '';
    private restored = false;
    private sourceIdentity = '';
    private directory = '';
    private materialized = '';
    private operations: Promise<void> = Promise.resolve();
    constructor(readonly file: string, private storageRoot: string) {}
    matchesSource(stat: fs.Stats) { return !this.sourceIdentity || this.identity(stat) === this.sourceIdentity; }
    get dirty() { return this.pieces !== this.savedPieces; }
    get contentPath() { return this.dirty ? this.materialized || this.file : this.file; }
    private identity(stat: fs.Stats) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
    private async allocate() {
        if (!this.directory) {
            await fs.promises.mkdir(this.storageRoot, { recursive: true });
            this.directory = await fs.promises.mkdtemp(path.join(this.storageRoot, 'record-edit-'));
        }
    }
    private async snapshot() {
        if (this.pieces) return;
        await this.allocate();
        const before = await fs.promises.stat(this.file);
        const copy = path.join(this.directory, `base-${crypto.randomUUID()}.snapshot`);
        await fs.promises.copyFile(this.file, copy, fs.constants.COPYFILE_EXCL);
        const [originalHash, copyHash, after] = await Promise.all([
            hashFile(this.file), hashFile(copy), fs.promises.stat(this.file),
        ]);
        if (originalHash !== copyHash || this.identity(before) !== this.identity(after)) {
            await fs.promises.unlink(copy);
            throw new Error('largeFileEditConflict');
        }
        this.sourceHash = originalHash;
        this.sourceIdentity = this.identity(after);
        this.pieces = [{ file: copy, offset: 0, length: before.size }];
        this.savedPieces = this.pieces;
        this.materialized = copy;
    }
    private async exclusive<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.operations;
        let release!: () => void;
        this.operations = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await action(); } finally { release(); }
    }
    async prepare(firstLine: number, lastLine: number): Promise<RecordDraft> {
        return this.exclusive(async () => {
            if (!Number.isSafeInteger(firstLine) || !Number.isSafeInteger(lastLine) || firstLine < 0 || lastLine < firstLine || lastLine - firstLine >= 240)
                throw new Error('largeFileEditBounds');
            await this.snapshot();
            // Recovery reads the immutable backup even if the source was moved or changed.
            // Saving over the original still requires the original identity and hash.
            if (!this.restored) {
                const sourceStat = await fs.promises.stat(this.file);
                if (!(sourceStat.mode & 0o222)) throw new Error('largeFileEditReadOnly');
                if (!this.matchesSource(sourceStat)) throw new Error('largeFileEditConflict');
            }
            const version = this.version;
            let line = 0, position = 0, start = -1, end = -1, bytes = 0, lineBytes = 0;
            const parts: Buffer[] = [];
            outer: for await (const value of fs.createReadStream(this.contentPath)) {
                const chunk = value as Buffer;
                let cursor = 0;
                while (cursor < chunk.length) {
                    const newline = chunk.indexOf(10, cursor);
                    const stop = newline < 0 ? chunk.length : newline + 1;
                    if (line >= firstLine && line <= lastLine) {
                        if (start < 0) start = position + cursor;
                        const part = chunk.subarray(cursor, stop); parts.push(part); bytes += part.length; lineBytes += part.length;
                        if (bytes > MAX_BYTES || lineBytes > 65538) throw new Error('largeFileEditBounds');
                    }
                    if (newline >= 0) {
                        if (line === lastLine) { end = position + stop; break outer; }
                        line++; lineBytes = 0;
                    }
                    cursor = stop;
                }
                position += chunk.length;
            }
            if (start < 0 || line < lastLine) throw new Error('largeFileEditBounds');
            const raw = Buffer.concat(parts);
            if (end < 0) end = start + raw.length;
            // Keep the BOM outside an editable range.
            const bom = start === 0 && raw.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0;
            const body = raw.subarray(bom);
            let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); }
            catch { throw new Error('largeFileEditEncoding'); }
            if (text.includes('\0') || text.includes('\r') && /\r(?!\n)/.test(text)) throw new Error('largeFileEditEncoding');
            return { version, start: start + bom, end, text: text.replace(/\r\n/g, '\n'), raw: body, firstLine };
        });
    }
    private slice(pieces: Piece[], start: number, end: number): Piece[] {
        const result: Piece[] = []; let cursor = 0;
        for (const piece of pieces) {
            const left = Math.max(start, cursor), right = Math.min(end, cursor + piece.length);
            if (left < right) result.push({ ...piece, offset: piece.offset + left - cursor, length: right - left });
            cursor += piece.length;
        }
        return result;
    }
    private async writePieces(file: string, pieces: Piece[], cancelled?: () => boolean) {
        const output = await fs.promises.open(file, 'wx');
        try {
            for (const piece of pieces) {
                if (!piece.length) continue;
                for await (const chunk of fs.createReadStream(piece.file, { start: piece.offset, end: piece.offset + piece.length - 1 })) {
                    if (cancelled?.()) throw new Error('largeFileEditCancelled');
                    const bytes = chunk as Buffer;
                    let offset = 0;
                    while (offset < bytes.length) { const result = await output.write(bytes, offset, bytes.length - offset); offset += result.bytesWritten; }
                }
            }
            await output.sync();
        } finally { await output.close(); }
    }
    private async install(pieces: Piece[]) {
        const file = path.join(this.directory, `view-${crypto.randomUUID()}.snapshot`);
        try { await this.writePieces(file, pieces); }
        catch (error) { await fs.promises.unlink(file).catch(() => {}); throw error; }
        const previous = this.materialized;
        this.pieces = pieces; this.materialized = file; this.version++;
        // Base/payload files remain immutable; old rendered snapshots are no longer referenced by pieces.
        if (previous && path.basename(previous).startsWith('view-') && !pieces.some(p => p.file === previous) &&
            !this.savedPieces?.some(p => p.file === previous)) await fs.promises.unlink(previous).catch(() => {});
    }
    async apply(draft: RecordDraft, text: string) {
        return this.exclusive(async () => {
            if (!this.pieces || draft.version !== this.version) throw new Error('largeFileEditConflict');
            if (typeof text !== 'string' || text.includes('\0') || text.includes('\r') ||
                text.split('\n').length - (text.endsWith('\n') ? 1 : 0) > 240 || Buffer.byteLength(text) > MAX_BYTES ||
                text.split('\n').some(line => Buffer.byteLength(line) > 65536) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
                throw new Error('largeFileEditBounds');
            const original = draft.raw.toString('utf8');
            const oldLines = original.match(/[^\n]*\n|[^\n]+$/g) || [];
            const preferred = original.includes('\r\n') ? '\r\n' : '\n';
            const newLines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
            const normalized = newLines.map((line, index) => oldLines[index]?.replace(/\r\n/g, '\n') === line
                ? oldLines[index] : line.endsWith('\n') ? line.slice(0, -1) + preferred : line).join('');
            const payload = Buffer.from(normalized);
            if (payload.equals(draft.raw)) return null;
            const payloadPath = path.join(this.directory, `${crypto.randomUUID()}.edit`);
            await fs.promises.writeFile(payloadPath, payload, { flag: 'wx' });
            const before = this.pieces;
            const after = [...this.slice(before, 0, draft.start), { file: payloadPath, offset: 0, length: payload.length },
                ...this.slice(before, draft.end, Infinity)];
            await this.install(after);
            return { undo: () => this.exclusive(() => this.install(before)), redo: () => this.exclusive(() => this.install(after)) };
        });
    }
    async save(target = this.file, cancelled?: () => boolean) {
        return this.exclusive(async () => {
            await this.snapshot();
            const same = process.platform === 'win32' ? path.resolve(target).toLowerCase() === path.resolve(this.file).toLowerCase() : path.resolve(target) === path.resolve(this.file);
            const stat = await fs.promises.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || !(stat.mode & 0o222))) throw new Error('largeFileEditReadOnly');
            const targetHash = stat ? await hashFile(target) : null;
            if (same && (!stat || this.identity(stat) !== this.sourceIdentity || targetHash !== this.sourceHash)) throw new Error('largeFileEditConflict');
            const candidate = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
            try {
                await this.writePieces(candidate, this.pieces!, cancelled);
                if (stat) await fs.promises.chmod(candidate, stat.mode);
                const candidateHash = await hashFile(candidate);
                for (let attempt = 0; ; attempt++) {
                    const now = await fs.promises.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
                    if ((stat ? !now || this.identity(now) !== this.identity(stat) || await hashFile(target) !== targetHash : now !== null)) throw new Error('largeFileEditConflict');
                    if (cancelled?.()) throw new Error('largeFileEditCancelled');
                    try { await fs.promises.rename(candidate, target); break; }
                    catch (error) {
                        // Windows readers can briefly deny replacement. Revalidate before every retry.
                        if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }
                if (same) {
                    const replaced = await fs.promises.stat(target);
                    if (await hashFile(target) !== candidateHash || this.identity(replaced) !== this.identity(await fs.promises.stat(target)))
                        throw new Error('largeFileEditConflict');
                    this.sourceHash = candidateHash; this.sourceIdentity = this.identity(replaced); this.savedPieces = this.pieces;
                }
            } finally { await fs.promises.unlink(candidate).catch(() => {}); }
        });
    }
    async revert() {
        return this.exclusive(async () => {
            const before = { pieces: this.pieces, savedPieces: this.savedPieces, materialized: this.materialized,
                sourceHash: this.sourceHash, sourceIdentity: this.sourceIdentity };
            this.pieces = null; this.savedPieces = null; this.materialized = '';
            try { await this.snapshot(); this.restored = false; this.version++; }
            catch (error) { Object.assign(this, before); throw error; }
        });
    }
    get checkpoint() { return this.pieces; }
    async restoreCheckpoint(pieces: Piece[]) { return this.exclusive(() => this.install(pieces)); }
    async backup(destination: string, extra?: unknown) {
        return this.exclusive(async () => {
            await this.snapshot();
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            const data = `${destination}.${crypto.randomUUID()}.snapshot`;
            await this.writePieces(data, this.pieces!);
            await fs.promises.writeFile(destination, JSON.stringify({ version: 1, source: this.file,
                hash: this.sourceHash, identity: this.sourceIdentity, extra: typeof extra === 'function' ? extra() : extra, data: path.basename(data) }));
            return { id: destination, delete: async () => { await fs.promises.unlink(destination).catch(() => {}); await fs.promises.unlink(data).catch(() => {}); } };
        });
    }
    async restore(backup: string) {
        const value = JSON.parse(await fs.promises.readFile(backup, 'utf8'));
        if (value.version !== 1 || value.source !== this.file || typeof value.hash !== 'string' || typeof value.identity !== 'string' ||
            typeof value.data !== 'string' || path.basename(value.data) !== value.data || !value.data.startsWith(path.basename(backup) + '.')) throw new Error('largeFileEditConflict');
        await this.allocate();
        const base = path.join(this.directory, `base-${crypto.randomUUID()}.snapshot`);
        await fs.promises.copyFile(path.join(path.dirname(backup), value.data), base, fs.constants.COPYFILE_EXCL);
        this.pieces = [{ file: base, offset: 0, length: (await fs.promises.stat(base)).size }];
        this.sourceHash = value.hash; this.sourceIdentity = value.identity; this.materialized = base; this.version++;
        this.restored = true;
        return value.extra;
    }
    async dispose() { if (this.directory) await fs.promises.rm(this.directory, { recursive: true, force: true }); }
}

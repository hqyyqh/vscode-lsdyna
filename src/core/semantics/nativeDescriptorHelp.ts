import { keywordDataPath } from "../keywordDataPath";
import { isDescriptorIdentity, descriptorIdentityGroup } from './descriptorIdentity';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { ByteLru } from '../cache/byteLru';

const root = keywordDataPath("native-help");
const source = "a88ab2e74e93a959971f487c72fa62bec157a3c762c37718e5571738a3ce50b5";
const cache = new ByteLru<Record<string, any>>(8 * 1024 * 1024);
let manifest: any;
let manifestSha: string;
let nativeNullHelp: Record<string, { name: string; type: number; help: string }> | undefined;
const preparing = new Map<string, Promise<void>>();
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function supplement(prepared?: { descriptor: any; encoded: Buffer; decoded: Buffer }): Record<string, { name: string; type: number; help: string }> {
    if (nativeNullHelp) return nativeNullHelp;
    const descriptor = prepared?.descriptor || JSON.parse(fs.readFileSync(path.join(root, 'native-null-help.manifest.json'), 'utf8'));
    if (!descriptor || descriptor.sourceSha256 !== source ||
        descriptor.catalogSha256 !== manifestSha ||
        descriptor.file !== 'native-null-help.json.gz' ||
        descriptor.uncompressedBytes > 8 * 1024 * 1024) {
        throw new Error('Native null-help supplement identity mismatch');
    }
    const encoded = prepared?.encoded || fs.readFileSync(path.join(root, descriptor.file));
    if (sha(encoded) !== descriptor.sha256) throw new Error('Native null-help supplement hash mismatch');
    const decoded = prepared?.decoded || zlib.gunzipSync(encoded, { maxOutputLength: descriptor.uncompressedBytes });
    if (decoded.length !== descriptor.uncompressedBytes || sha(decoded) !== descriptor.uncompressedSha256) {
        throw new Error('Native null-help supplement content mismatch');
    }
    const payload = JSON.parse(decoded.toString());
    if (payload.sourceSha256 !== source || !payload.fields ||
        Object.keys(payload.fields).length !== descriptor.nativeHelpFields) {
        throw new Error('Native null-help supplement payload mismatch');
    }
    nativeNullHelp = payload.fields;
    return nativeNullHelp!;
}

function loadManifest(bytes?: Buffer) {
    if (manifest) return;
    bytes = bytes || fs.readFileSync(path.join(root, 'manifest.json'));
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.sourceSha256 !== source) throw new Error('Native field help source mismatch');
    manifestSha = sha(bytes);
    manifest = value;
}

function loadFields(group: string, prepared?: { encoded: Buffer; decoded: Buffer }) {
    let fields = cache.get(group);
    if (fields) return fields;
    const descriptor = manifest.shards[group];
    if (!descriptor) return undefined;
    if (descriptor.file !== group + '.json.gz' || descriptor.uncompressedBytes > 8 * 1024 * 1024)
        throw new Error('Native field help shard bounds mismatch');
    const encoded = prepared?.encoded || fs.readFileSync(path.join(root, descriptor.file));
    if (sha(encoded) !== descriptor.sha256) throw new Error('Native field help shard hash mismatch');
    const decoded = prepared?.decoded || zlib.gunzipSync(encoded, { maxOutputLength: descriptor.uncompressedBytes });
    if (decoded.length !== descriptor.uncompressedBytes || sha(decoded) !== descriptor.uncompressedSha256)
        throw new Error('Native field help content mismatch');
    fields = JSON.parse(decoded.toString());
    cache.set(group, fields!, decoded.length);
    return fields;
}

async function prepare(key: string, operation: () => Promise<void>) {
    if (preparing.has(key)) return preparing.get(key);
    const pending = operation();
    preparing.set(key, pending);
    try { await pending; } finally { preparing.delete(key); }
}

async function decode(descriptor: any) {
    const encoded = await fs.promises.readFile(path.join(root, descriptor.file));
    if (sha(encoded) !== descriptor.sha256) throw new Error('Native field help shard hash mismatch');
    const decoded = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(encoded,
        { maxOutputLength: descriptor.uncompressedBytes }, (error, value) => error ? reject(error) : resolve(value)));
    return { encoded, decoded };
}

export async function prepareNativeDescriptorHelp(fields: any[]): Promise<void> {
    const addresses = fields.map(field => field?.fieldRecordId).filter(address => isDescriptorIdentity(address));
    if (!addresses.length) return;
    if (!manifest) await prepare('manifest', async () => loadManifest(await fs.promises.readFile(path.join(root, 'manifest.json'))));
    for (const group of new Set<string>(addresses.map(address => descriptorIdentityGroup(address)))) {
        const descriptor = manifest.shards[group];
        if (!descriptor || cache.get(group)) continue;
        await prepare(group, async () => {
            if (descriptor.file !== group + '.json.gz' || descriptor.uncompressedBytes > 8 * 1024 * 1024)
                throw new Error('Native field help shard bounds mismatch');
            loadFields(group, await decode(descriptor));
        });
    }
    if (!nativeNullHelp && fields.some(field => {
        const native = cache.get(descriptorIdentityGroup(String(field?.fieldRecordId || '')))?.[field?.fieldRecordId];
        return native && native.name === field.name && native.type === field.type && typeof native.help !== 'string';
    })) await prepare('supplement', async () => {
        const descriptor = JSON.parse(await fs.promises.readFile(path.join(root, 'native-null-help.manifest.json'), 'utf8'));
        if (descriptor.sourceSha256 !== source || descriptor.catalogSha256 !== manifestSha ||
            descriptor.file !== 'native-null-help.json.gz' || descriptor.uncompressedBytes > 8 * 1024 * 1024)
            throw new Error('Native null-help supplement identity mismatch');
        supplement({ descriptor, ...await decode(descriptor) });
    });
}

/** Help is joined by native address and identity, never by physical card number. */
export function nativeDescriptorHelp(field: any): string | undefined {
    const address = field?.fieldRecordId;
    if (!isDescriptorIdentity(address)) return undefined;
    loadManifest();
    const fields = loadFields(descriptorIdentityGroup(address));
    if (!fields) return undefined;
    const native = fields[address];
    if (native?.name !== field.name || native.type !== field.type) return undefined;
    if (typeof native.help === 'string') return native.help;
    const fallback = supplement()[address];
    return fallback?.name === field.name && fallback.type === field.type && typeof fallback.help === 'string'
        ? fallback.help : undefined;
}

export function withNativeDescriptorHelp(rule: any): any {
    const cards = (values: any[]) => values.map(card => ({ ...card,
        fields: card.fields.map(field => {
            const help = nativeDescriptorHelp(field);
            return help === undefined ? field : { ...field, help };
        }) }));
    return { ...rule, ...(rule.cards ? { cards: cards(rule.cards) } : {}),
        ...(rule.recordSelection?.cards ? { recordSelection: { ...rule.recordSelection, cards: cards(rule.recordSelection.cards) } } : {}) };
}

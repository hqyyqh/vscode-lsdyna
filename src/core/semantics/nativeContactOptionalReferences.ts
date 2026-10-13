import * as crypto from 'crypto';
import { keywordDataPath } from '../keywordDataPath';
import type { NativeFileRecord } from "./catalogNativeFileLayout";

const executable = "99091ea6216c85df477661324f422cc6674b2b655d4d19360767ed334c671168";
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

/** The shared optional table is separate from the keyword's three GUI cards. */
export function validateNativeContactOptionalSource(input: any): any {
    const { contentSha256, ...core } = input || {};
    const reject = () => { throw new Error('Native CONTACT auxiliary source identity mismatch'); };
    if (core.ownerAliasesEvidence) {
        const { ownerAliasesEvidence: proof, ...previous } = core;
        previous.contactOptionalBindings = core.contactOptionalBindings.slice(0, 2);
        previous.records = core.records.slice(0, 14);
        previous.summary = { fields: 14, sourceBranches: 14, exactSpellings: 2, optionalDescriptors: 9 };
        const priorHash = hash(JSON.stringify(canonical(previous)));
        if (contentSha256 !== hash(JSON.stringify(canonical(core))) ||
            priorHash !== "e0e8a429c758812b7faf4715accff71ee9afcd080e5dd1962aaa61b1b8dd1d25" ||
            proof.priorContentSha256 !== priorHash ||
            hash(JSON.stringify(canonical(proof))) !== "b4538a1d622e78a2c5fbf327358d418c353503f81a2aced5d3757eeec939db8a" ||
            hash(JSON.stringify(canonical(core.contactOptionalBindings.slice(2)))) !== "505a338844254ff0fdd3bea6a3d535c3696ea792f4d89fbea02c9d5382bddd6f" ||
            hash(JSON.stringify(canonical(core.records.slice(14)))) !== "178f787e9a650d7a0819e01a9e9348dd8a08a435066be7bac9cfa6ed57eb6361" ||
            JSON.stringify(canonical(core.summary)) !== JSON.stringify(canonical({ fields: 99, sourceBranches: 99, exactSpellings: 13, optionalDescriptors: 9 }))) reject();
        validateNativeContactOptionalSource({ ...previous, contentSha256: priorHash });
        return input;
    }
    const resolver = core.source?.targetResolver;
    const resolverPolicy = core.source?.relationPolicy === 'native-object-target-resolver';
    if (resolverPolicy && (resolver?.address !== "record:ed91305ae16dbcdbd533423e:1f40e38057bf3b78b25de073" ||
        resolver.codeSha256 !== 'c8beae8809e13cdfd551d8fae6b7b4eeb7e9f73000e1cf42f9ea554328afe26b' ||
        resolver.verificationSha256 !== '79bcd06bcf3b438548de5e02cdda2e6fad45bb10000f34be0d794ba1f27d52c6' ||
        resolver.checks !== 8780 || resolver.failures !== 0 ||
        resolver.packedTargetSelectionReadsFieldValue !== false || resolver.packedTargetSelectionReadsSoft !== false)) reject();
    if (core.schemaVersion !== 1 || core.kind !== 'dynasense-lspp-native-auxiliary-reference-fields' ||
        contentSha256 !== hash(JSON.stringify(canonical(core))) || core.source?.datasetSha256 !== executable ||
        core.source.readerAddress !== "record:e9aca6525b7fc64cb345bbb5:5823ff168d4f17c245822829" ||
        core.source.readerLogicalSha256 !== '9be1dd1328f4b1bbdad20eeb112771b5d4b9115ec4d8ac7fda6dfee5ebbc6f43' ||
        core.source.tableAddress !== "record:3c11134d2da44eeb1b070a21:b4aeb3a726511df4c86fbe36" ||
        core.source.tableSha256 !== 'b26478e66309ca1060f60874e058dacdc0f62e62d97b41f3a18a0bbfb81dca7c' ||
        hash(Buffer.from(core.source.tableBytes || '', 'hex')) !== core.source.tableSha256 ||
        core.source.originalInputEvidenceSha256 !== 'b7908a082fcd24929a544938ba9b11043ed0af05d8723f34e50cc80bd2ab2c1f' ||
        core.source.originalInputReferenceWindowFailures !== 0 ||
        !Array.isArray(core.contactOptionalBindings) || !Array.isArray(core.records)) reject();
    const thermal = core.contactOptionalBindings.length === 2;
    if (thermal ? !resolverPolicy ||
        hash(JSON.stringify(canonical(core.contactOptionalBindings))) !== "e588e825203c1338b1dcef755473622eeac7b07c2206eb05cb2428b01d0f5f0d" ||
        hash(JSON.stringify(canonical(core.records))) !== "c296cdb38a84d2e47eb257b39c6cd97e9489a7484af97cd67a47b36ed047707d"
        : core.contactOptionalBindings.length !== 1 ||
        hash(JSON.stringify(canonical(core.contactOptionalBindings[0]))) !== "31c33c55ba24b0e0cc8c5ec0bce675d5970f3623a03927295090e4b1332c431a" ||
        hash(JSON.stringify(canonical(core.records))) !== (resolverPolicy
            ? 'f7979c703a38dad04560cb5165e02bbb2d3e7815eb7340755a91f48eb6015d09'
            : 'fc8830a20ba80c9ff8a190e241198cd244e81b33582c9f339fdfc294f7babee9')) reject();
    return input;
}

let loadedSource: any;
export function nativeAuxiliaryReferenceSource(): any {
    if (loadedSource === undefined) {
        const source = require('../references/referenceRuleCatalog').getReferenceRuleCatalog().metadata('nativeAuxiliaryReferenceFields');
        loadedSource = source ? validateNativeContactOptionalSource(source) : null;
    }
    return loadedSource;
}

/** Each verified spelling is bound to its original registration and all GUI header fields. */
export function nativeContactOptionalBinding(rule: any, name: string, source?: any): any | null {
    const keyword = name.replace(/^\*/, '');
    if (rule?.catalogSource?.datasetSha256 !== executable) return null;
    // The pinned shared table only owns CONTACT spellings; unrelated cards must not load it.
    if (source === undefined && !keyword.startsWith('CONTACT_')) return null;
    const input = source === undefined ? nativeAuxiliaryReferenceSource() : source;
    if (!input) return null;
    const binding = input.contactOptionalBindings?.find((item: any) => item.keyword === keyword);
    if (!binding) return null;
    if (source !== undefined) validateNativeContactOptionalSource(input);
    if (!binding || rule.cardSetId !== binding.cardSetId || rule.cards?.length !== binding.catalogCardCount) return null;
    for (const expected of binding.mandatoryCards) {
        const card = rule.cards.find((item: any) => item.cardIndex === expected.cardIndex);
        if (!card || card.cardRecordId !== expected.cardRecordId ||
            card.fields?.length !== expected.fields.length || expected.fields.some((field: any, index: number) =>
                ["fieldRecordId", 'fieldIndex', 'name', 'type', 'position', 'width'].some(key => card.fields[index]?.[key] !== field[key]) ||
                card.fields[index].serializationPosition !== field.position ||
                card.fields[index].serializationWidth !== field.width)) return null;
    }
    return binding;
}

export function nativeContactOptionalCards(rule: any, binding: any): any[] {
    return [...rule.cards.slice(0, binding.bodyCardCount ?? rule.cards.length).map((card: any) => binding.cardOverrides?.find((item: any) => item.cardIndex === card.cardIndex) || card),
        ...binding.optionalCards].map(card => ({ ...card, fields: card.fields.map((field: any) => ({
        ...field, nativeLongWidth: 20, nativeReadGeometry: {
            long: { position: field.fieldIndex * 20, width: 20 },
            // The native CONTACT file dispatcher filters the local I10 flag.
            i10: { position: field.position, width: field.width },
        },
    })) }));
}

/** The exact source profile bounds the records consumed by one keyword. */
export function nativeContactOptionalRecordReader(binding: any) {
    let count = 0;
    return { next(_text?: string, _line?: number): NativeFileRecord {
        const cardIndex = ++count <= binding.maximumRecords ? count : 0;
        return { cardIndex, instanceStart: 0, key: `instance:0:card:${cardIndex}:row:${count - 1}` };
    }, complete: () => count >= binding.minimumRecords };
}

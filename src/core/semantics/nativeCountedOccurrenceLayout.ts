import { keywordDataPath } from "../keywordDataPath";
import type { NativeFileRecord } from "./catalogNativeFileLayout";

const data = require(keywordDataPath("native-readers/lspp-occurrence-readers.json"));

export function nativeCountedOccurrenceBinding(keyword: string): any {
    return data.bindings[keyword.replace(/^\*/, '')];
}

export function nativeCountedOccurrenceSource(): string { return data.sourceSha256; }

/** Resolve only the 0/1 instance boundaries established by native causal probes. */
export function selectCountedOccurrenceLayout(binding: any, rows: string[],
    read: (row: number, card: number, field: number) => string,
    resolve: (raw: string, row: number) => string) {
    const current: NativeFileRecord[] = [], counts: number[] = [], reasons = new Set<string>();
    let failureKind: 'input-uncertain' | undefined;
    const finish = (complete: boolean) => ({ current, target: current.slice(), counts,
        conditions: [], reasons: [...reasons], failureKind, complete });
    const fail = (reason: string) => { reasons.add(reason); failureKind = 'input-uncertain'; return finish(false); };
    const record = (cardIndex: number, start: number, branchIdentity = '', occurrence = 0): NativeFileRecord => ({
        cardIndex, instanceStart: start, branchIdentity,
        key: `instance:${start}:card:${cardIndex}${occurrence ? `:repeat:${occurrence}` : ''}`,
    });
    let start = 0;
    while (start < rows.length) {
        const availablePrefix = Math.min(binding.prefix.length, rows.length - start);
        if (availablePrefix < binding.prefix.length) {
            for (const card of binding.prefix.slice(0, availablePrefix)) current.push(record(card, start));
            return finish(true); // Native accepts an entity truncated by the keyword boundary.
        }
        const values: { control: any; value: number }[] = [];
        for (const control of binding.controls) {
            const offset = binding.prefix.indexOf(control.card);
            if (offset < 0) return fail(`control-${control.name}-record-unavailable`);
            const raw = resolve(read(start + offset, control.card, control.field), start + offset).trim();
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(raw))
                return fail(`control-${control.name}-${raw ? 'unresolved' : 'blank'}`);
            const value = Number(raw.replace(/[dD]/g, 'e'));
            if (!Number.isSafeInteger(value) || !control.allowed.includes(value))
                return fail(`control-${control.name}-outside-verified-domain`);
            values.push({ control, value });
        }
        if (values.filter(item => item.value > 0).length > binding.maximumActiveControls)
            return fail('simultaneous-count-controls-unverified');
        const conditions = values.map(item => `${item.control.name}=${item.value}`);
        const branchIdentity = conditions.join(';');
        for (const card of binding.prefix) current.push(record(card, start, branchIdentity));
        const tail = values.flatMap(item => Array.from({ length: item.value }, () => item.control.records).flat());
        const availableTail = Math.min(tail.length, rows.length - start - binding.prefix.length);
        const occurrences = new Map<number, number>();
        for (const card of tail.slice(0, availableTail)) {
            const occurrence = occurrences.get(card) || 0;
            current.push(record(card, start, branchIdentity, occurrence));
            occurrences.set(card, occurrence + 1);
        }
        if (availableTail < tail.length) return fail('controlled-records-missing');
        const count = binding.prefix.length + tail.length;
        counts.push(count); start += count;
    }
    return finish(true);
}

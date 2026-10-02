import { keywordDataPath } from "../keywordDataPath";
import { keywordInputFormat, stripKeywordInputFormatMarker, type KeywordInputFormatMode } from '../parser/inputFormat';

const rules = require(keywordDataPath("native-readers/lspp-native-input-format.json"));
const sourceSha256 = "68aa1f658eaeed8dc2b33eb9687eb349cf754d1f3fc51959a2364b9fdb071423";

function boundReader(rule: any, keywordText: string): any {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const binding = rules.bindings[keyword];
    return rules.sourceSha256 === sourceSha256 && binding?.cardSetId === rule?.cardSetId ? binding : undefined;
}

export function nativeReadInputFailure(rule: any, keywordText: string, globalFormat: KeywordInputFormatMode): string | undefined {
    return globalFormat === 'long' && keywordInputFormat(keywordText, globalFormat) === 'i10' && boundReader(rule, keywordText)
        ? 'native-mixed-global-long-local-i10-flags-unimplemented' : undefined;
}

/** Native dispatcher I10 filtering for independently bound ordinary numeric readers. */
export function nativeReadInputFormat(rule: any, keywordText: string,
    globalFormat: KeywordInputFormatMode): KeywordInputFormatMode {
    const requested = keywordInputFormat(keywordText, globalFormat);
    // The input enum cannot represent simultaneous global LONG and local I10 flags.
    if (requested !== 'i10' || globalFormat === 'long') return requested;
    const binding = boundReader(rule, keywordText);
    if (!binding) return requested;
    
    // pass through the same actual dispatcher-slot gate, independently of LONG.
    return rules.i10PreservedSlots.includes(binding.slot) ? requested : 'standard';
}

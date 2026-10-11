import { keywordDataPath } from "../keywordDataPath";
import { keywordInputFormat, stripKeywordInputFormatMarker, type KeywordInputFormatMode } from '../parser/inputFormat';

const rules = require(keywordDataPath("native-readers/lspp-native-input-format.json"));
const constrained = require(keywordDataPath("native-readers/lspp-constrained-input-format.json"));
const sourceSha256 = "1e631456cbcdea5193fc695a2d1bc2a4c8075e88a7a0dc00451d76b24e9504bb";

function boundReader(rule: any, keywordText: string): any {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const reference = require("./catalogNativeFileLayout").nativeReferenceFileBinding(keyword);
    const secondary = constrained.sourceSha256 === sourceSha256 &&
        rule?.catalogSource?.datasetSha256 === sourceSha256 ? constrained.bindings[keyword] : undefined;
    const binding = secondary || rules.bindings[keyword] || (rule?.catalogSource?.datasetSha256 === sourceSha256
        ? reference?.kind.startsWith('seismic-') ? { ...reference, slot: 40 }
            : [1, 13, 17, 18, 25, 35, 40, 42].includes(reference?.slot) ? reference : undefined : undefined);
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
    return (binding.i10Preserved ?? rules.i10PreservedSlots.includes(binding.slot)) ? requested : 'standard';
}

import { keywordDataPath } from '../keywordDataPath';
import { descriptorIdentityAt } from './descriptorIdentity';

const data = require(keywordDataPath('native-readers/lspp-optional-card-controls.json'));

/** Native GUI cardinality is separate from suffix parsing and field predicates. */
export function nativeOptionalCardControl(keyword: string, rule: any): any | null {
    const binding = data.bindings[keyword.replace(/^\*/, '').toUpperCase()];
    if (!binding || rule?.catalogSource?.datasetSha256 !== data.sourceSha256 ||
        binding.cardSetId !== rule.cardSetId || !Array.isArray(rule.cards) || binding.cardCount > rule.cards.length ||
        !Number.isInteger(binding.firstCard) || binding.firstCard < 2 ||
        !Number.isInteger(binding.maximum) || binding.maximum < 1 ||
        binding.firstCard - 1 + binding.maximum !== binding.cardCount ||
        rule.states || rule.domains || rule.recordSelection || rule.controllerFields?.length ||
        rule.cards.slice(0, binding.cardCount).some((card: any, index: number) => card.cardIndex !== index + 1 || card.when ||
            card.cardRecordId !== descriptorIdentityAt(binding.cardSetId, index))) return null;
    return binding;
}

/** A parser accepting a suffix with no record effect does not establish a GUI option. */
export function nativeFormSelectors(rule: any): any[] {
    return (rule.selectors || []).flatMap((selector: any) => {
        const values = String(rule.ownerDefinitionFile || '').startsWith('native-spelling:')
            ? (selector.values || []).filter((value: any) => value.cards?.length > 0)
            : selector.values;
        return values?.length ? [{ ...selector, values }] : [];
    });
}

import {
    CONTACT_FIELD_LABEL_SYNONYMS, getVerifiedPrefixLayout, getEnglishFieldHelp, getLocalizedFieldHelp,
    getFiniteRenderedCardsForLookup, lookupKeywordSchema,
    type KeywordLookup, type KeywordField, type KeywordCard, type KeywordSchema,
} from '../keywordSchema';

type Field = { name: string; position: number; width: number; cardIndex?: number; originalName?: string };
const normalize = (name: string) => String(name || '').trim().toUpperCase();
const placeholder = (name: string) => !name || /^(?:[-_]+|NOT USED|UNUSED|BLANK|N\/A|NONE|RESERVED)$/.test(name);

// These are schema-label associations, not interchangeable solver parameters.
// Evidence: current field schema descriptions and LSPP input-form branch cards.
function canonicalName(lookup: KeywordLookup, name: string, position: number, siblings: Field[]): string {
    const value = normalize(name);
    const keyword = lookup.canonicalName;
    if (/^CONTACT_/.test(keyword)) return CONTACT_FIELD_LABEL_SYNONYMS[value] || value;
    if (/^(?:MAT_JOHNSON_COOK(?:_STOCHASTIC)?|MAT_MODIFIED_JOHNSON_COOK|MAT_015)$/.test(keyword)) {
        if (value === 'C2/P/XNP') return 'C2/P/XNP/D';
        const groups = ['D1/BETA', 'D2/WC', 'D3/DC', 'D4/GAMMA', 'C2/P/XNP/D'];
        return groups.find(group => group === value || group.split('/').includes(value)) || value;
    }
    if (keyword === 'ALE_STRUCTURED_MESH_VOLUME_FILLING' && siblings.some(f => normalize(f.name) === 'GEOM')) {
        if (position === 20 && ['PSID', 'PID', 'SEGSID', 'SLDSID', 'SHLID', 'BEAMID', 'NID1', 'BOXID', 'NID'].includes(value)) return 'E1';
        if (position === 30 && ['OFFSET', 'NID2', 'RADIIX'].includes(value)) return 'E2';
        if (position === 40 && ['RADII1', 'RADIIY'].includes(value)) return 'E3';
        if (position === 50 && ['RADII2', 'RADIIZ'].includes(value)) return 'E4';
        if (position === 60 && value === 'LCSID') return 'E5';
    }
    if (keyword === 'ALE_STRUCTURED_MESH_TRIM' && value === 'OUT/IN') return 'IOUTIN';
    return value;
}

export function resolveManagerSchemaField(lookup: KeywordLookup | null, selected: Field,
    selectedCard?: { fields: Field[]; cardIndex?: number } | null, activeOptionsOnly = false): KeywordField | null {
    if (!lookup?.entry || !selected || placeholder(normalize(selected.name))) return null;
    const siblings = (selectedCard?.fields || [selected]).filter(f => !placeholder(normalize(f.name)));
    const sameGeometry = (f: Field, target: KeywordField) =>
        Number(f.position) === Number(target.p) && Number(f.width) === Number(target.w);
    const equivalent = (f: Field, target: KeywordField) => {
        const names = [f.name, f.originalName].filter(Boolean) as string[];
        return names.some(name => {
            const left = canonicalName(lookup, name, f.position, siblings);
            const right = canonicalName(lookup, target.n, Number(target.p), siblings);
            if (left === right) return true;
            // Descriptive title aliases apply only to text fields in identity cards.
            return f.position === 10 && f.width === 70 &&
                ['TITLE', 'HEADING', 'DESC', 'DESCRIPTION'].includes(left) &&
                ['TITLE', 'HEADING', 'DESC', 'DESCRIPTION', 'LABEL', 'NAME'].includes(right);
        });
    };
    const prefix = getVerifiedPrefixLayout(lookup)?.cards || [];
    // LSPP card indexes identify branch descriptors, not rendered-array offsets.
    // Match the card's field signature, including geometry, so ID/MPP prefixes and
    // repeated records never shift help onto a different card.
    const cards: KeywordCard[] = (selectedCard?.cardIndex ?? selected.cardIndex) === 0 && prefix.length
        ? prefix : activeOptionsOnly ? getFiniteRenderedCardsForLookup(lookup) : [...prefix, ...(lookup.entry.c || []),
            ...(lookup.entry.o || []).flatMap(option => option.c || [])];
    const candidates = new Map<string, KeywordField>();
    for (const card of cards) {
        const target = card.find(f => sameGeometry(selected, f) && equivalent(selected, f));
        if (!target) continue;
        let anchors = 0;
        let conflict = false;
        for (const sibling of siblings) {
            const atPosition = card.filter(f => sameGeometry(sibling, f) && !placeholder(normalize(f.n)));
            if (atPosition.length === 0) continue;
            if (atPosition.some(f => equivalent(sibling, f))) anchors++;
            else if (!(lookup.canonicalName === 'ALE_STRUCTURED_MESH_TRIM' && sibling.position >= 40 &&
                selected.position < 40 && siblings.some(f => normalize(f.name) === 'OPTION'))) conflict = true;
            // TRIM's first four controls are shared by all geometry branches; its
            // remaining schema fields describe only the part-set branch. Never
            // use that branch's PSID/DIST help for NID/R fields.
        }
        if (!conflict && anchors >= Math.min(2, siblings.length)) {
            candidates.set(JSON.stringify(target), target);
        }
    }
    const matches = [...candidates.values()];
    if (matches.length <= 1) return matches[0] || null;
    // Repeated schema records can have different help-slot IDs with identical
    // definitions. That is duplicate data, not an ambiguous field meaning.
    const definition = (field: KeywordField) => JSON.stringify([normalize(field.n), field.p, field.w, field.t,
        getEnglishFieldHelp(field), getLocalizedFieldHelp(field)]);
    const first = definition(matches[0]);
    return matches.every(field => definition(field) === first) ? matches[0] : null;
}

/** Use only the native-equivalent spellings belonging to the resolved form.
 * Shared registrations are deliberately excluded: they may be different inputs.
 */
export function managerHelpLookups(keyword: string, schema: KeywordSchema, nativeForm?: {
    spellingGroups?: Array<{ relation?: string; keywords?: string[] }>;
}): KeywordLookup[] {
    const input = normalize(keyword).replace(/^\*/, '');
    const group = nativeForm?.spellingGroups?.find(group => group.relation === 'native-equivalent-spellings' &&
        group.keywords?.some(name => input === name || input === `${name}_TITLE` || input === `${name}_ID`));
    const base = group?.keywords?.find(name => input === name || input === `${name}_TITLE` || input === `${name}_ID`);
    const suffix = base ? input.slice(base.length) : '';
    const names = group?.keywords?.map(name => `${name}${suffix}`) || [input];
    // Prefer the descriptive spelling when numeric aliases collide in field_data.
    names.sort((a, b) => Number(/^MAT_\d+(?:_|$)/.test(a)) - Number(/^MAT_\d+(?:_|$)/.test(b)));
    const lookups = names.map(name => lookupKeywordSchema(name, schema)).filter(Boolean) as KeywordLookup[];
    return [...new Map(lookups.map(lookup => [lookup.inputName, lookup])).values()];
}

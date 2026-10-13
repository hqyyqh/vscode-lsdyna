import type { EntityReferencesViewState, EntityReferenceLocationItem } from '../../../src/client/entityReferencesProtocol';

export function mergeEntityReferencePage(previous: EntityReferencesViewState | null, next: EntityReferencesViewState) {
    if (previous && previous.revision > next.revision) return previous;
    const update = next.appendPage || next.retainResults;
    if (!update) return next;
    if (!previous || previous.revision !== update.baseRevision ||
        previous.activeSession?.key !== next.activeSession?.key) return previous;
    const merge = (before: EntityReferenceLocationItem[], after: EntityReferenceLocationItem[]) =>
        [...new Map([...before, ...after].map(row => [row.locationId, row])).values()];
    return { ...next, appendPage: undefined, retainResults: undefined,
        definitions: merge(previous.definitions, next.definitions),
        references: merge(previous.references, next.references) };
}

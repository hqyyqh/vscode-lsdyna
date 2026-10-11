import type { EntityReferencesViewState } from '../../../src/client/entityReferencesProtocol';

export function mergeEntityReferencePage(previous: EntityReferencesViewState | null, next: EntityReferencesViewState) {
    if (previous && previous.revision > next.revision) return previous;
    if (!next.appendPage) return next;
    if (!previous || previous.revision !== next.appendPage.baseRevision ||
        previous.activeSession?.key !== next.activeSession?.key) return previous;
    return { ...next, appendPage: undefined,
        definitions: [...previous.definitions, ...next.definitions],
        references: [...previous.references, ...next.references] };
}

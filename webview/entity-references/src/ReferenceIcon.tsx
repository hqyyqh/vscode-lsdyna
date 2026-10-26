const icons = {
    side: 'split-horizontal',
    close: 'close',
    entity: 'symbol-class',
    curve: 'graph-line',
    definition: 'go-to-file',
    warning: 'warning',
    file: 'file',
    keyword: 'symbol-keyword',
} as const;

export function ReferenceIcon({ name }: { name: keyof typeof icons }) {
    return <span className={`reference-icon codicon codicon-${icons[name]}`} aria-hidden="true" />;
}

import './codicons.css';

export type CodiconName = 'arrow-left' | 'arrow-right' | 'arrow-up' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'file-pdf' | 'search' | 'close' | 'zoom-in' | 'zoom-out' | 'target' | 'book' | 'discard' | 'refresh' | 'check' | 'globe' | 'split-horizontal';

export function Codicon({ name, className = '' }: { name: CodiconName; className?: string }) {
    return <span className={`ui-icon ui-icon--${name} ${className}`} aria-hidden="true" />;
}

import React from 'react';

interface TranslationOverlayProps {
    id: string;
    text: string;
    pinned: boolean;
    label: string;
    closeLabel: string;
    position: { left: number; top: number };
    onClose: () => void;
}

export function TranslationOverlay({ id, text, pinned, label, closeLabel, position, onClose }: TranslationOverlayProps): React.JSX.Element {
    return <div
        id={id}
        className={`translation-tooltip${pinned ? ' translation-tooltip--pinned' : ''}`}
        role={pinned ? 'dialog' : 'tooltip'}
        aria-label={pinned ? label : undefined}
        style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
        <span>{text}</span>
        {pinned ? <button type="button" aria-label={closeLabel} onClick={onClose}>×</button> : null}
    </div>;
}

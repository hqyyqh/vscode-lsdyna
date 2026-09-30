import { useEffect, useRef, type ReactNode } from 'react';

/** Native modality keeps focus and pointer interaction out of the background form. */
export function ManagerDialog({ className, label, busy = false, onClose, children, restoreFocus }: {
    className: string; label: string; busy?: boolean; onClose: () => void; children: ReactNode;
    restoreFocus?: HTMLElement | null;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const trigger = restoreFocus ?? document.activeElement as HTMLElement | null;
        const dialog = ref.current!;
        dialog.showModal();
        dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
        return () => {
            dialog.close();
            if (trigger?.isConnected) trigger.focus();
        };
    }, []);
    return <dialog ref={ref} className={className} aria-label={label} aria-modal="true"
        onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
        {children}
    </dialog>;
}

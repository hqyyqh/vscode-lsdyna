import React, { useEffect, useRef, useState } from 'react';

interface ImageLightboxProps {
    src: string;
    alt: string;
    caption: string;
    label: string;
    zoomInLabel: string;
    zoomOutLabel: string;
    resetLabel: string;
    closeLabel: string;
    onClose: () => void;
}

interface Point { x: number; y: number }

function boundedZoom(value: number): number {
    return Math.min(5, Math.max(.25, Math.round(value * 100) / 100));
}

export function ImageLightbox({
    src, alt, caption, label, zoomInLabel, zoomOutLabel, resetLabel, closeLabel, onClose,
}: ImageLightboxProps): React.JSX.Element {
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
    const drag = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    // Keep latest zoom setter for the non-passive wheel listener without re-binding every frame.
    const setZoomRef = useRef(setZoom);
    setZoomRef.current = setZoom;

    useEffect(() => {
        closeRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKeyDown);

        // React's onWheel is passive in modern engines, so preventDefault there is a no-op and
        // the document still scrolls. Capture wheel on the dialog with { passive: false }.
        const dialog = dialogRef.current;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            // Only zoom when the gesture is over the image stage (toolbar stays scroll-locked too).
            const stage = stageRef.current;
            if (stage && (event.target instanceof Node) && stage.contains(event.target)) {
                setZoomRef.current(value => boundedZoom(value + (event.deltaY < 0 ? .25 : -.25)));
            }
        };
        dialog?.addEventListener('wheel', onWheel, { passive: false, capture: true });

        const html = document.documentElement;
        const body = document.body;
        const previousHtmlOverflow = html.style.overflow;
        const previousBodyOverflow = body.style.overflow;
        html.style.overflow = 'hidden';
        body.style.overflow = 'hidden';

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            dialog?.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
            html.style.overflow = previousHtmlOverflow;
            body.style.overflow = previousBodyOverflow;
        };
    }, [onClose]);

    const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
    const trapFocus = (event: React.KeyboardEvent) => {
        if (event.key !== 'Tab') return;
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])];
        if (!controls.length) return;
        const first = controls[0];
        const last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };

    // Figure/stage fill the dialog, so "click outside image" rarely hits the root.
    // Dismiss on any press that is not the image, caption, or toolbar controls.
    const dismissIfBackdrop = (event: React.MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.reader-lightbox__toolbar, .reader-lightbox__stage img, .reader-lightbox figcaption')) {
            return;
        }
        onClose();
    };

    return <div
        ref={dialogRef}
        className="reader-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={trapFocus}
        onMouseDown={dismissIfBackdrop}
    >
        <div className="reader-lightbox__toolbar">
            <button type="button" aria-label={zoomOutLabel} onClick={() => setZoom(value => boundedZoom(value - .25))}>−</button>
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
            <button type="button" aria-label={zoomInLabel} onClick={() => setZoom(value => boundedZoom(value + .25))}>+</button>
            <button type="button" aria-label={resetLabel} onClick={reset}>1:1</button>
            <button ref={closeRef} type="button" aria-label={closeLabel} onClick={onClose}>×</button>
        </div>
        <figure className="reader-lightbox__figure">
            <div ref={stageRef} className="reader-lightbox__stage">
                <img
                    src={src}
                    alt={alt}
                    draggable={false}
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                    onPointerDown={event => {
                        drag.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, pan };
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                    onPointerMove={event => {
                        const active = drag.current;
                        if (!active || active.pointerId !== event.pointerId) return;
                        setPan({ x: active.pan.x + event.clientX - active.origin.x, y: active.pan.y + event.clientY - active.origin.y });
                    }}
                    onPointerUp={event => {
                        if (drag.current?.pointerId === event.pointerId) drag.current = null;
                        event.currentTarget.releasePointerCapture?.(event.pointerId);
                    }}
                />
            </div>
            {caption ? <figcaption>{caption}</figcaption> : null}
        </figure>
    </div>;
}

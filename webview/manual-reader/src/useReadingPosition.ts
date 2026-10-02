import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { ReaderViewModel } from '../../../src/manual/readerProtocol';
import type { ReaderTransport } from './ReaderApp';

function ratioAt(scrollY: number): number {
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return maximum > 0 ? Math.min(1, Math.max(0, scrollY / maximum)) : 0;
}

export function useRestoreReadingPosition(view: ReaderViewModel | null): void {
    const contentKey = view?.content.kind === 'document' ? `${view.language}\0${view.content.chunkBaseUri}\0${view.content.markdown}` : view?.revision;
    useLayoutEffect(() => {
        if (!view) return;
        if (view.restore.anchorId) {
            const anchor = document.getElementById(view.restore.anchorId);
            if (anchor) { anchor.scrollIntoView(); return; }
        }
        const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        if (view.restore.scrollRatio > 0 && maximum > 0) {
            window.scrollTo(0, Math.round(maximum * view.restore.scrollRatio));
            return;
        }
        window.scrollTo(0, Math.max(0, view.restore.scrollY));
    }, [contentKey, view?.location.manualId, view?.location.sectionId, view?.restore.anchorId, view?.restore.scrollRatio, view?.restore.scrollY]);
}

export function useReadingPosition(view: ReaderViewModel | null, transport: ReaderTransport): {
    progress: number;
    showBackToTop: boolean;
    backToTop: () => void;
} {
    const [progress, setProgress] = useState(0);
    const [showBackToTop, setShowBackToTop] = useState(false);

    useEffect(() => {
        if (!view) return;
        let activeAnchor: string | null = null;
        let frame: number | ReturnType<typeof setTimeout> | undefined;
        let notifyTimer: ReturnType<typeof setTimeout> | undefined;
        const anchors = [...document.querySelectorAll<HTMLElement>('.markdown-body a[id]')];
        const toolbarHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-toolbar-height')) || 48;
        const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
            const visible = entries.filter(entry => entry.isIntersecting && (entry.target as HTMLElement).id).at(-1);
            if (visible) activeAnchor = (visible.target as HTMLElement).id;
        }, { rootMargin: `-${toolbarHeight}px 0px -70% 0px` }) : null;
        anchors.forEach(anchor => observer?.observe(anchor));

        const calculate = () => {
            frame = undefined;
            const scrollY = Math.max(0, window.scrollY);
            const scrollRatio = ratioAt(scrollY);
            setProgress(scrollRatio * 100);
            setShowBackToTop(scrollY > 320);
            const fallback = anchors.filter(anchor => anchor.getBoundingClientRect().top <= 96).at(-1);
            if (fallback?.id) activeAnchor = fallback.id;
            if (notifyTimer) clearTimeout(notifyTimer);
            notifyTimer = setTimeout(() => transport.notify('reader/scrollChanged', {
                revision: view.revision,
                anchorId: activeAnchor,
                scrollY,
                scrollRatio,
            }), 200);
        };
        const onScroll = () => {
            if (frame !== undefined) return;
            frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(calculate) : setTimeout(calculate, 0);
        };
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            observer?.disconnect();
            window.removeEventListener('scroll', onScroll);
            if (frame !== undefined) {
                if (typeof cancelAnimationFrame === 'function' && typeof frame === 'number') cancelAnimationFrame(frame);
                else clearTimeout(frame);
            }
            if (notifyTimer) clearTimeout(notifyTimer);
        };
    }, [transport, view?.revision, view?.content.kind === 'document' ? view.content.markdown : 'error']);

    const backToTop = useCallback(() => {
        const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    }, []);
    return { progress, showBackToTop, backToTop };
}

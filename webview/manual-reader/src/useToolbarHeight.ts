import { useLayoutEffect, type RefObject } from 'react';

/**
 * Keep --reader-toolbar-height in sync for search offset / scroll-margin.
 * Single-row toolbar has near-constant height; only publish when the measured
 * value changes to avoid layout thrash from sub-pixel ResizeObserver noise.
 */
export function useToolbarHeight(toolbarRef: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        const toolbar = toolbarRef.current;
        if (!toolbar) return;
        let last = '';
        const update = () => {
            const height = Math.max(0, Math.ceil(toolbar.getBoundingClientRect().height));
            if (height <= 0) return;
            const next = `${height}px`;
            if (next === last) return;
            last = next;
            document.documentElement.style.setProperty('--reader-toolbar-height', next);
        };
        update();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
        observer?.observe(toolbar);
        window.addEventListener('resize', update);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', update);
            document.documentElement.style.removeProperty('--reader-toolbar-height');
        };
    }, [toolbarRef]);
}

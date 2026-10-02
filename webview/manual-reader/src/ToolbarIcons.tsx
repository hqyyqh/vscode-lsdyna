import React from 'react';

/**
 * 16×16 stroke icons for reader chrome. Display size is CSS
 * (`.reader-toolbar__icon` → `--reader-toolbar-icon`, default 20px).
 * strokeWidth 1.5 ≈ 1.9px effective at 20px — lighter than bold UI, still clear.
 */
const base = {
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true as const,
    focusable: false as const,
    className: 'reader-toolbar__icon',
};

const stroke = {
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
};

export function IconChevronLeft(): React.JSX.Element {
    return <svg {...base}><path {...stroke} d="M10.25 2.25 4.75 8l5.5 5.75" /></svg>;
}

export function IconChevronRight(): React.JSX.Element {
    return <svg {...base}><path {...stroke} d="M5.75 2.25 11.25 8l-5.5 5.75" /></svg>;
}

export function IconArrowLeft(): React.JSX.Element {
    return <svg {...base}>
        <path {...stroke} d="M13.25 8H2.75" />
        <path {...stroke} d="M7.25 3.25 2.75 8l4.5 4.75" />
    </svg>;
}

export function IconArrowRight(): React.JSX.Element {
    return <svg {...base}>
        <path {...stroke} d="M2.75 8h10.5" />
        <path {...stroke} d="M8.75 3.25 13.25 8l-4.5 4.75" />
    </svg>;
}

export function IconArrowUp(): React.JSX.Element {
    return <svg {...base}>
        <path {...stroke} d="M8 12.75V3.25" />
        <path {...stroke} d="M3.75 7.5 8 3.25 12.25 7.5" />
    </svg>;
}

export function IconSearch(): React.JSX.Element {
    return <svg {...base}>
        <circle {...stroke} cx="7" cy="7" r="4.35" />
        <path {...stroke} d="m10.4 10.4 3.35 3.35" />
    </svg>;
}

export function IconPdf(): React.JSX.Element {
    return <svg {...base}>
        <path {...stroke} d="M3.75 1.5h5.5L12.5 4.75V13.5a1 1 0 0 1-1 1h-7.75a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Z" />
        <path {...stroke} d="M9.25 1.5v3.25H12.5" />
        <path {...stroke} d="M5.25 8.5h5.5M5.25 11.25h3.75" />
    </svg>;
}

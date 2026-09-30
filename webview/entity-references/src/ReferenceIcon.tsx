const paths = {
    chevron: 'm6 3 5 5-5 5',
    search: 'M10.5 10.5 14 14 M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    cursor: 'M3 2 12 8 8 9.5 6 14Z M11 2v3 M9.5 3.5h3',
    pin: 'm6 2 6 6-2 1-1 3-5-5 3-1Z M5 10l-3 4',
    side: 'M2 2h12v12H2Z M9 2v12 M4 8h3 M5.5 6.5 7 8l-1.5 1.5',
    refresh: 'M13 6a5 5 0 1 0 0 4 M13 2v4H9',
    close: 'm4 4 8 8 M12 4l-8 8',
} as const;

export function ReferenceIcon({ name, spinning = false }: { name: keyof typeof paths; spinning?: boolean }) {
    return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
        className={spinning ? 'reference-icon spinning' : 'reference-icon'}><path d={paths[name]} /></svg>;
}

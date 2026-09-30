const paths = {
    more: 'M3 8h.01 M8 8h.01 M13 8h.01',
    pin: 'm6 2 6 6-2 1-1 3-5-5 3-1Z M5 10l-3 4',
    locate: 'M8 1v3 M8 12v3 M1 8h3 M12 8h3 M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    manual: 'M8 3C6 1 3 2 1 2v11c2 0 5-1 7 1 2-2 5-1 7-1V2c-2 0-5-1-7 1Z M8 3v11',
    info: 'M8 7v5 M8 4v.5 M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
    close: 'm4 4 8 8 M12 4l-8 8',
    reset: 'M2 7a5 5 0 1 1 1 5 M2 3v4h4',
    collapse: 'm4 10 4-4 4 4',
    expand: 'm4 6 4 4 4-4',
} as const;

export function ManagerIcon({ name }: { name: keyof typeof paths }) {
    return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d={paths[name]} />
    </svg>;
}

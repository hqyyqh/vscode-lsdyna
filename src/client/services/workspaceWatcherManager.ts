const BUILT_IN_EXTENSIONS = ['.k', '.key', '.dyna', '.asc'];
const VALID_EXTENSION = /^\.[a-z0-9][a-z0-9._-]*$/i;
const FORBIDDEN_GLOB_CHARACTERS = /[\\/*?\[\]{}]/;

function normalizeExtension(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let extension = value.trim().toLowerCase();
    if (!extension) return null;
    if (!extension.startsWith('.')) extension = `.${extension}`;
    if (FORBIDDEN_GLOB_CHARACTERS.test(extension) || !VALID_EXTENSION.test(extension)) return null;
    return extension;
}

export function createWorkspaceWatcherManager({
    createWatcher,
    onFileEvent,
    logWarning = () => {},
}: {
    createWatcher: (glob: string) => any;
    onFileEvent: (uri: any) => void;
    logWarning?: (message: string) => void;
}) {
    if (typeof createWatcher !== 'function' || typeof onFileEvent !== 'function') {
        throw new TypeError('createWorkspaceWatcherManager requires createWatcher and onFileEvent');
    }

    let watchers: any[] = [];

    return {
        rebuild(configuredExtensions: unknown[]): string[] {
            const extensions = new Set(BUILT_IN_EXTENSIONS);
            for (const value of Array.isArray(configuredExtensions) ? configuredExtensions : []) {
                const normalized = normalizeExtension(value);
                if (normalized) extensions.add(normalized);
                else logWarning(`Ignoring invalid LS-DYNA extension: ${String(value)}`);
            }
            const ordered = [...extensions].sort();
            const nextWatchers: any[] = [];
            try {
                for (const extension of ordered) {
                    const watcher = createWatcher(`**/*${extension}`);
                    watcher.onDidChange(onFileEvent);
                    watcher.onDidCreate(onFileEvent);
                    watcher.onDidDelete(onFileEvent);
                    nextWatchers.push(watcher);
                }
            } catch (error) {
                for (const watcher of nextWatchers) watcher.dispose();
                throw error;
            }

            const previousWatchers = watchers;
            watchers = nextWatchers;
            for (const watcher of previousWatchers) watcher.dispose();
            return ordered;
        },

        dispose(): void {
            const current = watchers;
            watchers = [];
            for (const watcher of current) watcher.dispose();
        },
    };
}

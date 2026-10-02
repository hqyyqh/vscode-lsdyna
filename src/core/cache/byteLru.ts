export class ByteLru<T> {
    private readonly values = new Map<string, { value: T; bytes: number }>();
    private bytes = 0;

    constructor(private readonly maximumBytes: number) {}

    get(key: string): T | undefined {
        const entry = this.values.get(key);
        if (!entry) return undefined;
        this.values.delete(key);
        this.values.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T, bytes: number): void {
        if (bytes > this.maximumBytes || this.maximumBytes <= 0) return;
        const previous = this.values.get(key);
        if (previous) {
            this.values.delete(key);
            this.bytes -= previous.bytes;
        }
        this.values.set(key, { value, bytes });
        this.bytes += bytes;
        while (this.bytes > this.maximumBytes) {
            const oldest = this.values.keys().next().value;
            if (oldest === undefined) break;
            const entry = this.values.get(oldest);
            this.values.delete(oldest);
            this.bytes -= entry?.bytes || 0;
        }
    }
}

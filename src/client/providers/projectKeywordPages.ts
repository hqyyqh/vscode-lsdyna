import * as path from 'node:path';
import { indexJsonBytes } from '../../shared/indexPages';
const vscode = require('vscode');
const i18n = require('../../core/i18n');

/** Lazy project projection. Local document BlockIndex ownership stays in the existing provider. */
export class ProjectKeywordPages {
    private cache = new Map<string, { items: any[]; bytes: number }>();
    private disposed = false;
    private revision = -1;
    constructor(private request: (request: any, token?: any) => Promise<any>, public handle: any,
        private rootFile: string, private makeItem: (row: any, parent: any, layout: string) => any) {}

    async status(token?: any) {
        let status = await this.request({ action: 'status', ...this.handle }, token);
        if (status.state === 'stale' && status.generation !== undefined && status.generation !== this.handle.generation) {
            this.handle.generation = status.generation; this.revision = -1; this.cache.clear();
            status = await this.request({ action: 'status', ...this.handle }, token);
        }
        if (status.sequence !== this.revision) { this.revision = status.sequence; this.cache.clear(); }
        return status;
    }

    async children(layout: string, parent?: any) {
        if (this.disposed) return [];
        if (parent && !parent.projectPage) return [];
        const query = parent?.projectPage || { groupBy: layout === 'order' ? 'filePath'
            : layout === 'category' ? 'category' : 'keyword' };
        const key = JSON.stringify([layout, query]);
        if (this.cache.has(key)) return this.cache.get(key).items;
        const page = await this.request({ action: 'keywords', ...this.handle, ...query });
        if (this.disposed) return [];
        if (page.state === 'stale') {
            const item = new vscode.TreeItem(i18n.get('scanStructureIncomplete'), vscode.TreeItemCollapsibleState.None);
            item.parent = parent; return [item];
        }
        const items = page.rows.map(row => {
            if (row.type !== 'group') return this.makeItem(row, parent, layout);
            const item = new vscode.TreeItem(query.groupBy === 'filePath' ? path.basename(row.key) : row.key,
                vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `project-keywords:${this.rootFile}:${layout}:${query.category || ''}:${query.groupBy}:${row.key}`;
            item.parent = parent; item.kind = query.groupBy === 'keyword' ? 'keyword' : query.groupBy;
            item.keyword = query.groupBy === 'keyword' ? row.key : undefined;
            item.description = page.complete ? String(row.count) : i18n.get('projectItemsDiscovered', row.count);
            item.tooltip = query.groupBy === 'filePath' ? row.key : item.label;
            item.projectPage = query.groupBy === 'category' ? { category: row.key, groupBy: 'keyword' }
                : { ...(query.category ? { category: query.category } : {}), [query.groupBy]: row.key };
            return item;
        });
        if (page.next !== undefined) {
            const item = new vscode.TreeItem(i18n.get('projectNextPage'), vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `project-keywords:page:${key}:${page.next}`;
            item.parent = parent;
            item.projectPage = { ...query, offset: page.next, revision: page.revision };
            items.push(item);
        }
        // Retain only recently requested pages; never prefetch all occurrence pages.
        this.cache.set(key, { items, bytes: indexJsonBytes(page) * 4 });
        while (this.cache.size > 32 || [...this.cache.values()].reduce((sum, page) => sum + page.bytes, 0) > 8 * 1024 * 1024)
            this.cache.delete(this.cache.keys().next().value);
        return items;
    }

    async find(filePath: string, line: number, layout: string) {
        const page = await this.request({ action: 'keywords', ...this.handle, filePath, atLine: line });
        if (page.state === 'stale') return null;
        const row = page.rows[0];
        if (!row) return null;
        const findGroup = async (matches: (item: any) => boolean, parent?: any) => {
            while (!this.disposed) {
                const items = await this.children(layout, parent);
                const found = items.find(matches);
                if (found) return found;
                parent = items.find(item => item.projectPage?.offset !== undefined);
                if (!parent) return null;
            }
            return null;
        };
        let parent = await findGroup(item => item.projectPage && (layout === 'order'
            ? item.projectPage.filePath === filePath : layout === 'category'
                ? item.projectPage.category === row.category : item.projectPage.keyword === row.keyword));
        if (layout === 'category' && parent) parent = await findGroup(item => item.projectPage?.keyword === row.keyword, parent);
        return parent || null;
    }

    async search(onAccept: (row: any) => Promise<void>) {
        const picker = vscode.window.createQuickPick();
        picker.title = i18n.get('treeSearchKeywordTitle');
        picker.ignoreFocusOut = true;
        let generation = 0;
        const update = async (text: string, offset = 0, revision?: number) => {
            const own = ++generation; picker.busy = true;
            try {
                const page = await this.request({ action: 'keywords', ...this.handle, search: text, offset, revision });
                if (own !== generation || this.disposed) return;
                if (page.state === 'stale') {
                    picker.items = [{ label: i18n.get('scanStructureIncomplete'), alwaysShow: true }]; return;
                }
                picker.items = (page.rows || []).map(row => ({ label: row.keyword,
                    description: `${path.basename(row.filePath)}:${row.startLine + 1}`,
                    detail: row.filePath, row, alwaysShow: true }));
                if (page.next !== undefined) picker.items = [...picker.items,
                    { label: i18n.get('projectNextPage'), next: page.next, revision: page.revision, alwaysShow: true }];
            } catch (error) {
                if (own === generation && !this.disposed)
                    picker.items = [{ label: i18n.get('scanStructureIncomplete'), alwaysShow: true }];
            } finally { if (own === generation) picker.busy = false; }
        };
        const changed = picker.onDidChangeValue(text => { void update(text).catch(() => { picker.busy = false; }); });
        const accepted = picker.onDidAccept(() => {
            const item = picker.selectedItems[0];
            if (item?.next !== undefined) { void update(picker.value, item.next, item.revision); return; }
            if (item?.row) { picker.hide(); void onAccept(item.row); }
        });
        const hidden = picker.onDidHide(() => { generation++; changed.dispose(); accepted.dispose(); hidden.dispose(); picker.dispose(); });
        picker.show(); await update('');
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true; this.cache.clear();
        void this.request({ action: 'release', lease: this.handle.lease }).catch(() => {});
    }
}

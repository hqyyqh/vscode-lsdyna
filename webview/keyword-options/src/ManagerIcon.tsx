import { Codicon } from '../../shared/Codicon';

const icons = {
    previous: 'chevron-left', next: 'chevron-right', search: 'search',
    locate: 'target', manual: 'book', close: 'close',
    reset: 'refresh', expand: 'chevron-down', check: 'check',
} as const;

export function ManagerIcon({ name }: { name: keyof typeof icons }) {
    return <Codicon name={icons[name]} />;
}

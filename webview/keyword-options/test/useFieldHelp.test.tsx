import { act, renderHook } from '@testing-library/react';
import { useFieldHelp } from '../src/useFieldHelp';
import type { KeywordOptionsTransport } from '../src/transport';
import type { KeywordManagerHelpRequest, KeywordManagerHelpResult, KeywordOptionsViewState } from '../../../src/client/keywordOptionsProtocol';

function snapshot(revision = 1, instance = 'i'): KeywordOptionsViewState {
    return { revision, selectedInstanceId: instance, selectedFieldId: 'a', locale: 'en',
        cards: [{ fields: ['a', 'b', 'c', 'd'].map(fieldId => ({ fieldId })) }],
        help: { status: 'ready', fieldId: 'a', english: `a-${revision}` },
    } as KeywordOptionsViewState;
}

test('coalesces rapid selection, paints immediately and ignores superseded responses', async () => {
    const pending: { request: KeywordManagerHelpRequest; resolve: (r: KeywordManagerHelpResult) => void }[] = [];
    const transport = { selectField: vi.fn((request: KeywordManagerHelpRequest) =>
        new Promise<KeywordManagerHelpResult>(resolve => pending.push({ request, resolve }))) } as unknown as KeywordOptionsTransport;
    const { result, rerender } = renderHook(({ state }) => useFieldHelp(state, transport), { initialProps: { state: null as KeywordOptionsViewState | null } });
    rerender({ state: snapshot() });
    act(() => result.current.selectField('b'));
    expect(result.current.selectedFieldId).toBe('b');
    expect(result.current.help.status).toBe('loading');
    act(() => { result.current.selectField('c'); result.current.selectField('d'); });
    expect(pending).toHaveLength(1);
    await act(async () => pending[0].resolve({ ...pending[0].request, accepted: true,
        help: { status: 'ready', fieldId: 'b', english: 'old' } }));
    expect(pending).toHaveLength(2);
    expect(pending[1].request.fieldId).toBe('d');
    expect(result.current.help.status).toBe('loading');
    await act(async () => pending[1].resolve({ ...pending[1].request, accepted: true,
        help: { status: 'ready', fieldId: 'd', english: 'current' } }));
    expect(result.current.help.english).toBe('current');
    act(() => { result.current.selectField('a'); result.current.selectField('d'); });
    expect(pending).toHaveLength(2);
    rerender({ state: snapshot(2) });
    expect(result.current.selectedFieldId).toBe('d');
    expect(pending[2].request.revision).toBe(2);
    rerender({ state: snapshot(3, 'other') });
    expect(result.current.selectedFieldId).toBe('a');
    await act(async () => pending[2].resolve({ ...pending[2].request, accepted: true,
        help: { status: 'ready', fieldId: 'd', english: 'wrong instance' } }));
    expect(result.current.help.english).toBe('a-3');
    expect(pending[3].request.instanceId).toBe('other');
});

test('version mismatch waits for a fresh state and removed fields use the new default', async () => {
    const transport = { selectField: vi.fn(async (request: KeywordManagerHelpRequest) =>
        ({ ...request, accepted: false, reason: 'stale-revision' })) } as unknown as KeywordOptionsTransport;
    const { result, rerender } = renderHook(({ state }) => useFieldHelp(state, transport), { initialProps: { state: null as KeywordOptionsViewState | null } });
    rerender({ state: snapshot() });
    await act(async () => result.current.selectField('b'));
    expect(transport.selectField).toHaveBeenCalledTimes(1);
    expect(result.current.message).toBe('');
    const next = snapshot(2);
    next.cards[0].fields = next.cards[0].fields.filter(field => field.fieldId !== 'b');
    await act(async () => rerender({ state: next }));
    expect(result.current.selectedFieldId).toBe('a');
    expect(transport.selectField).toHaveBeenCalledTimes(2);
});

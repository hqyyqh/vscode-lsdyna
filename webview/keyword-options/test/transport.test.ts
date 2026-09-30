import { createKeywordOptionsTransport } from '../src/transport';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('vscode-messenger-webview', () => ({ Messenger: class {
    start() {}
    sendRequest = send;
} }));

test('queued edits rebase, but application retains the revision of the reviewed preview', async () => {
    send.mockResolvedValueOnce({ revision: 1 })
        .mockResolvedValueOnce({ accepted: true, state: { revision: 2 } })
        .mockResolvedValueOnce({ accepted: true, state: { revision: 3 } })
        .mockResolvedValueOnce({ accepted: false, state: { revision: 3 } });
    const api = createKeywordOptionsTransport({} as any);
    await api.ready();
    await api.updateField(1, 'SID', '42');
    await api.togglePin(1);
    expect(send.mock.calls[2][2].revision).toBe(2);
    await api.apply(2);
    expect(send.mock.calls[3][2].revision).toBe(2);
});

test('help bypasses a pending edit and does not advance the reviewed revision', async () => {
    send.mockReset();
    let finish!: (value: unknown) => void;
    const payload = { revision: 1, instanceId: 'i', fieldId: 'f', requestId: 3 };
    send.mockResolvedValueOnce({ revision: 1 })
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
        .mockResolvedValueOnce({ ...payload, accepted: true, help: { status: 'ready', fieldId: 'f' } })
        .mockResolvedValueOnce({ accepted: true, state: { revision: 2 } });
    const api = createKeywordOptionsTransport({} as any);
    await api.ready();
    const edit = api.updateField(1, 'f', '42');
    await Promise.resolve();
    expect((await api.selectField(payload)).accepted).toBe(true);
    expect(send.mock.calls[2][2]).toEqual(payload);
    finish({ accepted: true, state: { revision: 2 } });
    await edit;
    await api.apply(1);
    expect(send.mock.calls[3][2].revision).toBe(1);
});

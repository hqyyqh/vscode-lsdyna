import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeywordManagerHelpRequest, KeywordManagerHelpState, KeywordOptionsViewState } from '../../../src/client/keywordOptionsProtocol';
import type { KeywordOptionsTransport } from './transport';

// Selection is presentation state: reading help must never replace the edit model.
export function useFieldHelp(state: KeywordOptionsViewState | null, transport: KeywordOptionsTransport) {
    const [selection, setSelection] = useState<{ fieldId: string | null; help: KeywordManagerHelpState }>({
        fieldId: null, help: { status: 'none', fieldId: null },
    });
    const [message, setMessage] = useState('');
    const current = useRef<KeywordOptionsViewState | null>(null);
    const selected = useRef<string | null>(null);
    const desired = useRef<KeywordManagerHelpRequest | null>(null);
    const inFlight = useRef(false);
    const sequence = useRef(0);
    const cache = useRef(new Map<string, KeywordManagerHelpState>());
    const live = useRef(true);
    useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

    const pump = useCallback(function pump() {
        const request = desired.current;
        if (!live.current || inFlight.current || !request) return;
        desired.current = null;
        inFlight.current = true;
        const matches = () => live.current && sequence.current === request.requestId &&
            current.current?.revision === request.revision &&
            current.current?.selectedInstanceId === request.instanceId && selected.current === request.fieldId;
        const failed = () => {
            if (matches()) setMessage(current.current?.locale === 'zh'
                ? '字段帮助切换失败，请重新聚焦该字段重试。'
                : 'Could not switch field help. Focus the field again to retry.');
        };
        void transport.selectField(request).then(result => {
            if (!matches()) return;
            if (result.requestId !== request.requestId || result.revision !== request.revision ||
                result.instanceId !== request.instanceId || result.fieldId !== request.fieldId) return;
            if (result.accepted && result.help?.fieldId === request.fieldId) {
                cache.current.set(request.fieldId, result.help);
                setSelection({ fieldId: request.fieldId, help: result.help });
                setMessage('');
            } else if (result.reason !== 'stale-revision' && result.reason !== 'stale-context') failed();
        }).catch(failed).finally(() => { inFlight.current = false; pump(); });
    }, [transport]);

    const selectField = useCallback((fieldId: string) => {
        const snapshot = current.current;
        if (!snapshot) return;
        // A cached result also invalidates an older, still-running request.
        const help = cache.current.get(fieldId);
        if (selected.current === fieldId && (help || inFlight.current && sequence.current > 0 && !message)) return;
        selected.current = fieldId;
        const requestId = ++sequence.current;
        setMessage('');
        setSelection({ fieldId, help: help || { status: 'loading', fieldId } });
        desired.current = help ? null : { revision: snapshot.revision,
            instanceId: snapshot.selectedInstanceId, fieldId, requestId };
        pump();
    }, [pump, message]);

    useLayoutEffect(() => {
        if (current.current === state) return;
        const previous = current.current;
        current.current = state;
        if (previous && state && previous.revision === state.revision &&
            previous.selectedInstanceId === state.selectedInstanceId) return;
        cache.current.clear();
        desired.current = null;
        ++sequence.current;
        setMessage('');
        const fieldId = state?.selectedInstanceId === previous?.selectedInstanceId &&
            state?.cards.some(card => card.fields.some(field => field.fieldId === selected.current))
            ? selected.current : state?.selectedFieldId ?? null;
        selected.current = fieldId;
        if (!state || !fieldId) {
            setSelection({ fieldId: null, help: { status: 'none', fieldId: null } });
            return;
        }
        const seed = state.help.fieldId === fieldId ? state.help : { status: 'loading' as const, fieldId };
        setSelection({ fieldId, help: seed });
        if (!previous && seed.status !== 'loading') {
            cache.current.set(fieldId, seed);
            return;
        }
        desired.current = { revision: state.revision, instanceId: state.selectedInstanceId,
            fieldId, requestId: sequence.current };
        pump();
    }, [state, pump]);

    return { selectedFieldId: selection.fieldId, help: selection.help, message, selectField };
}

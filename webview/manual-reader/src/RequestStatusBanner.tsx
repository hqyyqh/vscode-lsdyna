import React from 'react';
import type { ReaderMessages } from './readerI18n';

interface RequestStatusBannerProps {
    error: string | null;
    pending: boolean;
    messages: ReaderMessages;
    onDismiss: () => void;
}

export function RequestStatusBanner({ error, pending, messages, onDismiss }: RequestStatusBannerProps): React.JSX.Element | null {
    if (error) return <div className="reader-request-banner reader-error" role="alert">
        <span>{error}</span>
        <button type="button" onClick={onDismiss}>{messages.dismiss}</button>
    </div>;
    if (pending) return <div className="reader-request-banner reader-pending" role="status">{messages.working}</div>;
    return null;
}

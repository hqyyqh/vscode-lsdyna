import React from 'react';
import type { ReaderUiLocale } from '../../../src/manual/readerProtocol';
import { readerMessages } from './readerI18n';

interface State { failed: boolean }

interface Props extends React.PropsWithChildren {
    locale?: ReaderUiLocale;
}

export class ReaderErrorBoundary extends React.Component<Props, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    componentDidCatch(error: Error): void {
        console.error('Manual reader render failed', error);
    }

    render(): React.ReactNode {
        const documentLocale = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
        if (this.state.failed) return <div className="reader-error" role="alert">{readerMessages(this.props.locale || documentLocale).renderFailed}</div>;
        return this.props.children;
    }
}

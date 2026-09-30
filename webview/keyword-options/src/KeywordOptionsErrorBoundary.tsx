import React from 'react';

interface State {
    failed: boolean;
    error: Error | null;
}

interface Props extends React.PropsWithChildren {
    locale?: 'en' | 'zh';
}

export class KeywordOptionsErrorBoundary extends React.Component<Props, State> {
    state: State = { failed: false, error: null };

    static getDerivedStateFromError(error: Error): State {
        return { failed: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        console.error('Keyword options webview render failed:', error, errorInfo);
    }

    private retry = (): void => {
        this.setState({ failed: false, error: null });
    };

    render(): React.ReactNode {
        if (!this.state.failed) {
            return this.props.children;
        }

        const isZh = this.props.locale !== undefined ? this.props.locale === 'zh' :
            typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('zh');

        return (
            <main className="errorBoundary" role="alert" style={{ padding: '16px 12px' }}>
                <div className="message error" style={{ borderLeft: '3px solid var(--vscode-errorForeground)' }}>
                    <strong>{isZh ? '无法显示关键字管理器' : 'Could not display Keyword Manager'}</strong>
                    <p>{isZh ? '请重试。若问题仍然存在，请关闭并重新打开关键字管理器。' : 'Try again. If the problem persists, close and reopen Keyword Manager.'}</p>
                    {this.state.error?.message && <details>
                        <summary>{isZh ? '错误详情' : 'Error details'}</summary>
                        <p style={{ overflowWrap: 'anywhere' }}>{this.state.error.message}</p>
                    </details>}
                    <button
                        type="button"
                        onClick={this.retry}
                        style={{
                            marginTop: '8px',
                            padding: '4px 12px',
                            background: 'var(--vscode-button-background)',
                            color: 'var(--vscode-button-foreground)',
                            border: '0',
                            borderRadius: '2px',
                            cursor: 'pointer',
                        }}
                    >
                        {isZh ? '重试' : 'Retry'}
                    </button>
                </div>
            </main>
        );
    }
}

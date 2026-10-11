import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KeywordOptionsApp } from './KeywordOptionsApp';
import { KeywordOptionsErrorBoundary } from './KeywordOptionsErrorBoundary';
import { createKeywordOptionsTransport } from './transport';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <KeywordOptionsErrorBoundary>
            <KeywordOptionsApp transport={createKeywordOptionsTransport()} />
        </KeywordOptionsErrorBoundary>
    </StrictMode>,
);

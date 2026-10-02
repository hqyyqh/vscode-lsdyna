import React from 'react';
import { createRoot } from 'react-dom/client';
import 'github-markdown-css/github-markdown.css';
import 'katex/dist/katex.min.css';
import { ReaderApp } from './ReaderApp';
import { ReaderErrorBoundary } from './ReaderErrorBoundary';
import { createReaderTransport } from './transport';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Manual reader root element is missing');
createRoot(root).render(<ReaderErrorBoundary><ReaderApp initialState={null} transport={createReaderTransport()} /></ReaderErrorBoundary>);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { LargeFileViewerApp } from './LargeFileViewerApp';
import { createLargeFileViewerTransport } from './transport';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><LargeFileViewerApp transport={createLargeFileViewerTransport()} /></React.StrictMode>,
);

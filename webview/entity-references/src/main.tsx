import React from 'react';
import ReactDOM from 'react-dom/client';
import { EntityReferencesApp } from './EntityReferencesApp';
import { createEntityReferencesTransport } from './transport';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><EntityReferencesApp transport={createEntityReferencesTransport()} /></React.StrictMode>,
);

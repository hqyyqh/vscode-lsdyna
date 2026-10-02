import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });

if (typeof ElementInternals !== 'undefined' && typeof ElementInternals.prototype.setFormValue !== 'function') {
    Object.defineProperty(ElementInternals.prototype, 'setFormValue', { configurable: true, value: vi.fn() });
}
(globalThis as typeof globalThis & { litIssuedWarnings?: Set<string> }).litIssuedWarnings = new Set(['dev-mode']);

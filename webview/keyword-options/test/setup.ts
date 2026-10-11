import '@testing-library/jest-dom/vitest';

// jsdom has no native dialog lifecycle; actual modality is checked in the browser.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };

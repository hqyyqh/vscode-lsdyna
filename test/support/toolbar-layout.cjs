'use strict';

// Runs inside the real Webview; callers retain the snapshot before asserting failures.
module.exports = async function toolbarLayout({ zh, drafts = false }) {
    const toolbar = document.querySelector('.detailsToolbar');
    if (!toolbar) throw Error('Help toolbar missing');
    toolbar.scrollIntoView({ block: 'nearest' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const issues = [];
    const controls = [...toolbar.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect();
        const text = button.textContent.trim();
        const label = button.getAttribute('aria-label') || text;
        if (!rect.width || !rect.height || !label) issues.push('Empty control: ' + label);
        if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1)
            issues.push('Clipped text: ' + label);
        const range = document.createRange();
        range.selectNodeContents(button);
        if ([...range.getClientRects()].some(textRect => textRect.left < rect.left - 1 || textRect.right > rect.right + 1))
            issues.push('Text outside button: ' + label);
        if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1)
            issues.push('Outside viewport: ' + label);
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (hit !== button && !button.contains(hit)) issues.push('Occluded control: ' + label);
        return { text, label, disabled: button.disabled, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const names = controls.map(control => control.text);
    if (!names.includes(zh ? '字段说明' : 'Field help')) issues.push('Wrong help language');
    if (!names.includes(zh ? '收起' : 'Collapse')) issues.push('Missing collapse action');
    if (drafts) for (const text of zh ? ['还原', '应用'] : ['Reset', 'Apply']) {
        if (!controls.some(control => control.text === text && !control.disabled)) issues.push('Draft action missing/disabled: ' + text);
    }
    const collapse = toolbar.querySelector('button[aria-expanded]');
    collapse.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (collapse.getAttribute('aria-expanded') !== 'false' || collapse.textContent.trim() !== (zh ? '展开' : 'Expand'))
        issues.push('Collapse did not change state/label');
    collapse.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (collapse.getAttribute('aria-expanded') !== 'true') issues.push('Expand did not restore state');
    const language = [...toolbar.querySelectorAll('button')].find(button => button.textContent.includes('[EN]'));
    if (zh && language) {
        const original = document.querySelector('.fieldHelp').textContent;
        language.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!language.textContent.includes('[中]')) issues.push('Language toggle did not switch');
        if (document.querySelector('.fieldHelp').textContent === original) issues.push('Language toggle did not change help');
        language.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (document.querySelector('.fieldHelp').textContent !== original) issues.push('Language toggle did not restore help');
    }
    return { viewport: { width: innerWidth, height: innerHeight }, font: getComputedStyle(document.body).fontSize,
        theme: document.body.dataset.vscodeThemeName, controls, languageToggle: !!language,
        text: toolbar.innerText, issues };
};

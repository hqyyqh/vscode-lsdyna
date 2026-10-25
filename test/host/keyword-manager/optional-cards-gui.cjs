'use strict';
module.exports = async function optionalCardsGui({ zh }) {
    const wait = () => new Promise(resolve => setTimeout(resolve, 30));
    const until = async check => {
        const end = Date.now() + 15000;
        while (!check()) { if (Date.now() > end) throw Error('Optional-card UI timeout: ' + document.body.innerText); await wait(); }
    };
    const select = () => document.querySelector('#inputForm-optional-cards');
    const cards = () => document.querySelectorAll('.cards .card').length;
    const apply = () => document.querySelector('.detailsActions .primaryText');
    const reset = () => document.querySelector('.detailsActions .toolbarTextAction:not(.primaryText)');
    const choose = value => { select().value = value; select().dispatchEvent(new Event('change', { bubbles: true })); };
    const snapshot = () => ({ text: document.body.innerText, value: select().value, cards: cards(),
        options: [...select().options].map(option => option.textContent) });
    await until(() => select() && document.querySelector('main').getAttribute('aria-busy') !== 'true');
    if (select().getAttribute('aria-label') !== (zh ? '可选卡片' : 'Optional cards') ||
        JSON.stringify([...select().options].map(option => option.textContent)) !== JSON.stringify([zh ? '无' : 'None', '1']))
        throw Error('Wrong optional-card labels');
    if (document.querySelector('.options select[aria-label="ID"]') || cards() !== 1 || select().value !== '')
        throw Error('Initial form has phantom ID or optional card');
    const initial = snapshot();
    if (!select().closest('.tagSelect.inactive')) throw Error('Optional cards bypasses the shared inactive selector');
    choose('1');
    await until(() => cards() === 2 && apply() && !apply().disabled && reset());
    if (!select().closest('.tagSelect.active')) throw Error('Optional cards bypasses the shared active selector');
    const main = document.querySelector('main');
    const originalStyle = main.getAttribute('style');
    main.style.width = '360px'; main.style.maxWidth = '100%';
    main.style.setProperty('--vscode-font-size', '20px'); main.style.fontSize = '20px';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const actionRects = [reset(), apply()].map(element => {
        const rect = element.getBoundingClientRect();
        if (element.scrollWidth > element.clientWidth || rect.width === 0 || rect.right > main.getBoundingClientRect().right + 1)
            throw Error('Optional-card action label clips at 360px / 20px');
        return { label: element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (originalStyle === null) main.removeAttribute('style'); else main.setAttribute('style', originalStyle);
    reset().click();
    await until(() => cards() === 1 && select().value === '');
    choose('1');
    await until(() => cards() === 2 && apply() && !apply().disabled);
    let input = document.querySelector('.field span[title="IOOPT"]').closest('.field').querySelector('input');
    input.focus(); input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await until(() => document.querySelector('.field.helpSelected span[title="IOOPT"]'));
    input = document.querySelector('.field span[title="IOOPT"]').closest('.field').querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(); input.blur(); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => document.querySelector('.fieldEditor.changed') && apply() && !apply().disabled);
    apply().click();
    await until(() => !apply() && select().value === '1' && document.querySelector('main').getAttribute('aria-busy') !== 'true');
    const saved = snapshot();
    choose('');
    await until(() => cards() === 1 && apply() && !apply().disabled && reset());
    const removal = snapshot();
    reset().click();
    await until(() => cards() === 2 && select().value === '1' && !apply());
    if (document.querySelector('.field span[title="IOOPT"]').closest('.field').querySelector('input').value.trim() !== '2')
        throw Error('Reset lost optional-card data');
    return { initial, saved, removal, narrowDraftActions: { width: 360, fontSize: 20, actionRects }, resetPreservedValue: true };
};

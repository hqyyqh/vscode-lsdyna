'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { writeEvidence } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function checkSelectorGui({ root, context, evaluate, refreshContext, call, pageSession, writeRequest, locale, language }) {
    const evaluateCurrent = evaluate;
    evaluate = async (_previousContext, expression) => {
        try { return await evaluateCurrent(context, expression); }
        catch (error) {
            if (!/Session with given id not found|Cannot find context|Execution context was destroyed/.test(String(error))) throw error;
            context = await refreshContext();
            return evaluateCurrent(context, expression);
        }
    };
    const interactions = await evaluate(context, '(' + (async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const until = async predicate => { const end = Date.now() + 10000;
            while (!predicate()) { if (Date.now() > end) throw Error(document.body.innerText); await wait(20); } };
        const check = (condition, name) => { if (!condition) throw Error(name + '\n' + document.body.innerText); checks.push(name); };
        const checks = [];
        const trigger = () => document.querySelector('.instanceTrigger');
        const input = () => document.querySelector('.instancePopover input[type=search]');
        const type = value => { const el = input(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true })); };
        const key = (el, value, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
        await until(() => trigger()?.textContent.includes('1/3') && !trigger().disabled);
        trigger().click(); await until(() => input());
        check(document.activeElement === input(), 'search-autofocus');
        check(document.querySelector('.instancePopover').getAttribute('aria-modal') === 'false' && !document.querySelector('dialog[open]'), 'nonmodal-dialog');
        const sort = document.querySelector('.instanceMeta select'); sort.value = 'id'; sort.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => trigger().textContent.includes('3/3'));
        check([...document.querySelectorAll('.instanceList button')].map(el => el.innerText).every((text, index) => text.includes(index < 2 ? 'MID 2' : 'MID 9')), 'stable-id-order');
        type('missing query'); await until(() => document.querySelectorAll('.instanceList button').length === 0);
        check(trigger().textContent.includes('3/3'), 'filter-does-not-change-total');
        check(document.querySelector('.instanceNotice')?.textContent, 'filtered-current-notice');
        key(input(), 'Escape'); await until(() => !input());
        check(document.activeElement === trigger(), 'escape-restores-trigger');
        trigger().click(); await until(() => input()); check(input().value === 'missing query', 'query-retained');
        document.querySelector('.instanceSearch button').click(); await until(() => input().value === '');
        key(input(), 'Enter', { isComposing: true }); await wait(30); check(!!input(), 'ime-enter-ignored');
        key(input(), 'ArrowDown'); check(document.activeElement.getAttribute('aria-current') === 'true', 'arrow-focuses-current');
        key(document.activeElement, 'ArrowUp'); check(document.activeElement.closest('.instanceList'), 'arrow-browses-results');
        key(input(), 'Enter'); await until(() => !input()); check(trigger().textContent.includes('3/3'), 'current-enter-no-op');
        trigger().click(); await until(() => input()); type('MID 2');
        await until(() => document.querySelectorAll('.instanceList button').length === 2);
        key(input(), 'Enter'); await until(() => !input() && trigger().textContent.includes('1/3') && document.querySelector('main').getAttribute('aria-busy') === 'false');
        check(document.activeElement === trigger(), 'accepted-switch-retains-manager-focus');
        trigger().click(); await until(() => input()); check(input().value === 'MID 2', 'query-retained-after-switch');
        key(input(), 'Escape'); await until(() => !input());
        document.querySelector('.instanceNavigation > button:last-of-type').click();
        await until(() => trigger().textContent.includes('2/3') && !trigger().disabled);
        check(trigger().textContent.includes('2/3'), 'arrows-follow-full-id-order');
        trigger().click(); await until(() => input());
        await wait(50); // Allow React's document focus listener to attach before synthetic Tab exit.
        const outside = document.querySelector('.headerActions > button');
        outside.focus(); outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await until(() => !input());
        check(document.activeElement === outside, 'focus-exit-keeps-new-focus');
        trigger().click(); await until(() => input()); document.querySelector('.instanceSearch button')?.click();
        await wait(30);
        return { checks, locale: document.documentElement.lang, text: document.querySelector('.instancePopover').innerText,
            controls: [...document.querySelector('.instancePopover').querySelectorAll('button,input,select')].map(el => ({
                label: el.getAttribute('aria-label'), text: el.innerText, current: el.getAttribute('aria-current'), disabled: el.disabled })) };
    }).toString() + ')()');
    const expectedLocale = language === 'auto' ? locale : language;
    assert.equal(interactions.locale, expectedLocale === 'zh-cn' ? 'zh-CN' : 'en');
    const states = [];
    const request = async action => {
        const id = `${action}/${Date.now()}`;
        await writeRequest(root, 'selector-request.json', { action, id });
        for (let attempt = 0; ; attempt++) {
            let applied;
            try { applied = JSON.parse(fs.readFileSync(path.join(root, 'selector-applied.json'))); } catch {}
            if (applied?.id === id) {
                if (applied.error) throw Error(applied.error);
                context = await refreshContext();
                return applied;
            }
            if (attempt === 300) throw Error('Selector request timed out: ' + action);
            await delay(50);
        }
    };
    const until = async expression => {
        for (let attempt = 0; ; attempt++) {
            if (await evaluate(context, expression)) return;
            if (attempt === 200) throw Error('Selector DOM timed out: ' + expression);
            await delay(50);
        }
    };
    const capture = async name => {
        const state = await evaluate(context, `({name:${JSON.stringify(name)}, text:document.body.innerText,
            controls:[...document.querySelectorAll('button,input,select,summary')].map(el=>({text:el.innerText,
                label:el.getAttribute('aria-label'),disabled:el.disabled})),
            focused:document.activeElement?.getAttribute('aria-label')})`);
        states.push(state);
        writeEvidence(path.join(root, 'selector-state-progress.json'), JSON.stringify(states, null, 2));
        const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
        writeEvidence(path.join(root, `selector-state-${name}.png`), Buffer.from(shot.data, 'base64'));
        return state;
    };
    await request('single');
    await until("document.querySelector('.instanceTrigger')?.textContent.includes('1/1') && !document.querySelector('.instanceTrigger').disabled");
    await evaluate(context, "document.querySelector('.instanceTrigger').click()");
    await until("!!document.querySelector('.instancePopover input')");
    const single = await capture('single');
    assert.match(single.text, /DT 0\.01.*BINARY 1/);
    assert.doesNotMatch(single.text, /LCUR 12|MID 12/);
    await evaluate(context, `(() => { const el=document.querySelector('.instancePopover input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'no match');
        el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until("document.querySelectorAll('.instanceList button').length === 0");
    const unmatched = await capture('single-no-match');
    assert.ok(unmatched.text.includes(expectedLocale === 'zh-cn' ? '显示 0 / 1 个实例' : 'Showing 0 of 1 instance'));
    await evaluate(context, "document.querySelector('.instancePopover input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await request('loading');
    await until("document.querySelector('.instanceTrigger')?.textContent.includes('…')");
    await capture('directory-loading-fault-gate');
    await request('failure');
    await until("!!document.querySelector('.instanceDirectoryNotice button')");
    await capture('directory-error-fault-injection');
    await evaluate(context, "document.querySelector('.instanceDirectoryNotice button').click()");
    await until("!document.querySelector('.instanceDirectoryNotice') && !document.querySelector('.instanceTrigger').disabled");
    await capture('directory-reload');
    await request('stale');
    await until("document.querySelector('.instanceTrigger').disabled");
    await capture('stale-source');
    await request('readonly');
    await until("document.querySelector('.instanceTrigger')?.textContent.includes('1/2') && !document.querySelector('.instanceTrigger').disabled");
    await evaluate(context, "document.querySelector('.instanceTrigger').click()");
    await until("document.querySelectorAll('.instanceList button').length === 2");
    await capture('readonly-browse');
    await evaluate(context, "document.querySelectorAll('.instanceList button')[1].click()");
    await until("document.querySelector('.instanceTrigger')?.textContent.includes('2/2') && !document.querySelector('.instanceTrigger').disabled");
    assert.equal(await evaluate(context, "!!document.querySelector('.primaryText:not(:disabled),.cards input:not([readonly])')"), false, 'readonly source cannot be edited');
    await request('empty-view');
    await until("document.querySelector('.instanceTrigger')?.textContent.includes('0/0')");
    await capture('empty-initial-state-replay');
    await request('material');
    await until("document.querySelector('.instanceTrigger')?.textContent.includes('1/3') && !document.querySelector('.instanceTrigger').disabled");
    const pageEvaluate = async expression => {
        const response = await call('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true }, pageSession);
        if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
        return response.result.value;
    };
    const confirm = async action => {
        await evaluate(context, "document.querySelector('.instanceNavigation > button:last-of-type').click()");
        let dialog;
        for (let attempt=0; !dialog; attempt++) {
            dialog = await pageEvaluate("document.querySelector('.monaco-dialog-box')?.innerText");
            if (attempt === 200) {
                const state = await capture('draft-confirmation-missing');
                throw Error('Draft confirmation did not render: ' + JSON.stringify({state,workbench:await pageEvaluate('document.body.innerText')}));
            }
            if (!dialog) await delay(50);
        }
        states.push({name:`draft-confirm-${action}`,text:dialog});
        const shot = await call('Page.captureScreenshot',{format:'png'},pageSession);
        writeEvidence(path.join(root,`selector-state-draft-confirm-${action}.png`),Buffer.from(shot.data,'base64'));
        const actionPattern = { cancel:'^(Cancel|取消)$',apply:'^(Apply changes|应用修改)$',discard:'^(Discard and switch|丢弃并切换)$' }[action];
        assert.ok(await pageEvaluate(`(() => { const button=[...document.querySelector('.monaco-dialog-box').querySelectorAll('button,.monaco-button')]
            .find(el=>new RegExp(${JSON.stringify(actionPattern)}).test(el.innerText.replaceAll('&','').trim()));
            button?.click();return !!button;})()`), 'native confirmation action: '+action);
        await until("document.querySelector('main').getAttribute('aria-busy') === 'false'");
    };
    const edit = value => evaluate(context, `(() => { const el=[...document.querySelectorAll('.field')].find(el=>el.querySelector('span[title=RO]')).querySelector('input');
        el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await edit('8.2');
    await delay(50);
    await capture('draft-local-input');
    await confirm('cancel');
    assert.ok(await evaluate(context, "document.querySelector('.instanceTrigger').textContent.includes('1/3') && [...document.querySelectorAll('.field')].find(el=>el.querySelector('span[title=RO]')).querySelector('input').value === '8.2'"));
    await capture('cancel-retains-input');
    await confirm('apply');
    await until("!!document.querySelector('.message')");
    const applied = await capture('applied-reselect');
    assert.ok(applied.text.includes(expectedLocale === 'zh-cn' ? '修改已应用，但未切换实例' : 'Your changes were applied. No instance was switched.'));
    assert.ok(await evaluate(context,"document.querySelector('.instanceTrigger').textContent.includes('1/3')"));
    await edit('8.3');
    await confirm('discard');
    await until("document.querySelector('.instanceTrigger').textContent.includes('2/3')");
    await capture('discard-switch');
    await evaluate(context, "document.querySelector('.instanceTrigger').click()");
    await until("!!document.querySelector('.instancePopover input')");
    await evaluate(context, "document.querySelector('.instanceFile summary').focus();document.querySelector('.instanceFile').open=true");
    assert.ok(await evaluate(context,"document.querySelector('.instanceFile div').textContent.includes('instance-selection.k')"), 'complete keyboard-readable source path');
    await capture('full-source-path');
    await evaluate(context, "document.querySelector('.instanceFile').open=false;document.querySelector('.instancePopover input').focus()");
    await request('clear-notifications');
    const layouts = [];
    for (const theme of ['Default Light Modern', 'Default Dark Modern', 'Default High Contrast']) {
        await writeRequest(root, 'theme-request.json', theme);
        for (let attempt = 0; ; attempt++) {
            try { if (JSON.parse(fs.readFileSync(path.join(root, 'theme-applied.json'))) === theme) break; } catch {}
            if (attempt === 200) throw Error('Theme update timed out'); await delay(50);
        }
        for (const zoom of [0, 1]) for (const [width, height] of [[360,800],[480,800],[960,800],[480,400]]) {
            const appearance = { zoom, id: `${theme}/${zoom}/${width}/${height}` };
            await writeRequest(root, 'appearance-request.json', appearance);
            for (let attempt = 0; ; attempt++) {
                try { if (JSON.parse(fs.readFileSync(path.join(root, 'appearance-applied.json'))).id === appearance.id) break; } catch {}
                if (attempt === 200) throw Error('Zoom update timed out'); await delay(50);
            }
            let viewportWidth = width + 60;
            for (let attempt = 0; attempt < 16; attempt++) {
                await call('Emulation.setDeviceMetricsOverride', { width: Math.round(viewportWidth), height, deviceScaleFactor: 1, mobile: false }, pageSession);
                await delay(120);
                const actual = await evaluate(context, 'innerWidth');
                if (actual === width) break;
                viewportWidth += (width - actual) * Math.pow(1.2, zoom);
            }
            const layout = await evaluate(context, `(() => { const panel = document.querySelector('.instancePopover');
                const rect = panel.getBoundingClientRect(); return { width: innerWidth, height: innerHeight,
                    documentWidth: document.documentElement.scrollWidth, font: getComputedStyle(document.body).fontSize,
                    theme: document.body.dataset.vscodeThemeName, text: panel.innerText, panel: {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
                    search: document.activeElement?.getAttribute('aria-label'),
                    controls: [...panel.querySelectorAll('button,input,select')].map(el => ({label:el.getAttribute('aria-label'),text:el.innerText,disabled:el.disabled})) }; })()`);
            assert.ok(Math.abs(layout.width - width) <= 1, 'requested Webview width');
            assert.ok(layout.documentWidth <= layout.width + 1, 'no horizontal page overflow');
            assert.ok(layout.panel.left >= 0 && layout.panel.right <= layout.width + 1 && layout.panel.top >= 0 && layout.panel.bottom <= layout.height + 1, 'popover contained');
            layouts.push({ requestedWidth: width, zoom, ...layout });
            const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
            writeEvidence(path.join(root, `selector-${theme.replaceAll(' ', '-')}-${zoom}-${width}-${height}.png`), Buffer.from(shot.data, 'base64'));
        }
    }
    const result = { passed: true, scope: 'development Extension Host, published runtime, synthetic deck', locale, language,
        dialogStyle: 'custom', nativeImeUnverified: true, keyboardAndFocusEventsAreScripted: true, emptyViewIsReplay: true,
        directoryFailureIsInjected: true, interactions, states, layouts, evidence: root };
    writeEvidence(path.join(root, 'selector-renderer.json'), JSON.stringify(result, null, 2));
    return { passed: true, locale, language, interactions: interactions.checks.length, layouts: layouts.length, evidence: root };
};

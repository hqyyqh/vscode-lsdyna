'use strict';

async function fetchJson(url, timeoutMs = 3000) {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (!response.ok) throw Error(`DevTools discovery returned HTTP ${response.status}`);
    return response.json();
}

function openSocket(url, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const socket = new (globalThis.WebSocket || require('undici').WebSocket)(url);
        const finish = error => {
            clearTimeout(timer);
            socket.removeEventListener('open', opened);
            socket.removeEventListener('error', failed);
            socket.removeEventListener('close', failed);
            if (error) { socket.close(); reject(error); } else resolve(socket);
        };
        const opened = () => finish();
        const failed = event => finish(Error('DevTools connection failed before opening', { cause: event.error }));
        const timer = setTimeout(() => finish(Error('DevTools connection timeout')), Math.max(1, timeoutMs));
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('close', failed, { once: true });
    });
}

function createCdp(socket, timeoutMs = 30000) {
    const pending = new Map();
    let nextId = 0, closed;
    const fail = error => {
        closed = error;
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        pending.clear();
    };
    socket.addEventListener('close', () => fail(Error('DevTools connection closed')));
    socket.addEventListener('error', event => fail(Error('DevTools connection failed', { cause: event.error })));
    socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(message.id);
        message.error ? entry.reject(Error(`${entry.method}: ${message.error.message}`)) : entry.resolve(message.result || {});
    });
    return {
        call(method, params = {}, sessionId) {
            if (closed || socket.readyState !== 1) return Promise.reject(closed || Error('DevTools connection is not open'));
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, timeoutMs);
                pending.set(id, { method, resolve, reject, timer });
                try { socket.send(JSON.stringify({ id, method, params, sessionId })); }
                catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
            });
        },
        close() { fail(Error('DevTools connection closed')); socket.close(); },
    };
}

module.exports = { fetchJson, openSocket, createCdp };

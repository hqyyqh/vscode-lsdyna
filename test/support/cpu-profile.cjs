'use strict';
const fs = require('node:fs');

async function withCpuProfile(enabled, output, operation) {
    if (!enabled) return operation();
    const session = new (require('node:inspector').Session)();
    const post = method => new Promise((resolve, reject) =>
        session.post(method, (error, value) => error ? reject(error) : resolve(value)));
    let started = false, failed = false;
    try {
        session.connect();
        await post('Profiler.enable');
        await post('Profiler.start');
        started = true;
        return await operation();
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        try {
            try {
                if (started) {
                    const { profile } = await post('Profiler.stop');
                    fs.writeFileSync(output, JSON.stringify(profile));
                }
            } finally { session.disconnect(); }
        } catch (error) {
            if (!failed) throw error;
            console.error('CPU profile cleanup failed:', error);
        }
    }
}

module.exports = { withCpuProfile };

'use strict';
const assert = require('node:assert/strict');
const defaults = { "record:40a8cc6df9c65f8a9f28a264:19624d17f45340e00f03f0db": '0', "record:40a8cc6df9c65f8a9f28a264:2d1db3331bdfb1056f76e5ad": '0', "record:918a1b8665d14093fb26fd77:8950fc5fc47e4d74470f5f06": '2', "record:918a1b8665d14093fb26fd77:ea44d574385ada5815a18268": '1' };

module.exports = function assertNativeReaderValue(field, observed, message) {
    assert.equal(field.rawValue, observed.rawValue, `${message} source token`);
    assert.equal(field.t, observed.type === 0 ? 'string' : observed.type === 1 ? 'integer' : 'real', `${message} type`);
    assert.deepEqual(field.nativeRange, observed.range, `${message} source range`);
    const defaultValue = defaults[observed.address];
    if (defaultValue !== undefined) assert.equal(field.d, defaultValue, `${message} default`);
    if (observed.type === 0) {
        assert.equal(observed.value, observed.rawValue.trim(), `${message} observed text`);
        return;
    }
    // Only these captured descriptor identities have observed blank/zero defaulting.
    const value = observed.rawValue === '' && ["record:40a8cc6df9c65f8a9f28a264:19624d17f45340e00f03f0db", "record:40a8cc6df9c65f8a9f28a264:2d1db3331bdfb1056f76e5ad"].includes(observed.address) ||
        observed.rawValue === '0' && ["record:918a1b8665d14093fb26fd77:8950fc5fc47e4d74470f5f06", "record:918a1b8665d14093fb26fd77:ea44d574385ada5815a18268"].includes(observed.address)
        ? defaultValue : observed.rawValue;
    const numeric = token => {
        assert.match(token, /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/, `${message} numeric token`);
        const number = Number(token.replace(/[dD]/g, 'e'));
        assert.ok(Number.isFinite(number), `${message} finite value`);
        if (observed.type === 1) assert.ok(Number.isInteger(number), `${message} integer value`);
        return number;
    };
    assert.equal(numeric(value), numeric(observed.value), `${message} observed number`);
};

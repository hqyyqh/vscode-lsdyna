'use strict';
const zlib = require('node:zlib');

module.exports = function deterministicGzip(bytes, options = {}) {
    const encoded = zlib.gzipSync(bytes, { ...options, mtime: 0 });
    // RFC 1952: 255 means unspecified OS. Do not bind generated data to its build host.
    encoded[9] = 255;
    return encoded;
};

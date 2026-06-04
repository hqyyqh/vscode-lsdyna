'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const workspaceRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(workspaceRoot, 'src');
const outRoot = path.join(workspaceRoot, 'out');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request.startsWith('.') || path.isAbsolute(request)) {
        const parentDir = parent && parent.filename ? path.dirname(parent.filename) : workspaceRoot;
        const absoluteRequest = path.resolve(parentDir, request);
        if (absoluteRequest === srcRoot || absoluteRequest.startsWith(srcRoot + path.sep)) {
            const outRequest = path.join(outRoot, path.relative(srcRoot, absoluteRequest));
            if (fs.existsSync(outRequest) || fs.existsSync(outRequest + '.js') || fs.existsSync(path.join(outRequest, 'index.js'))) {
                return originalResolveFilename.call(this, outRequest, parent, isMain, options);
            }
        }
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
};

require('./helpers');

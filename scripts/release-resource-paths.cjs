'use strict';
// Release-only paths. Authoring/evidence paths and the supported command-file language stay unchanged.
function releasePath(value) {
    return value.replace(/(^|[/\\])lspp(?!-cfile)(?=[A-Z_.-])/g, '$1catalog');
}
function authoringPath(value) {
    return value.replace(/(^|[/\\])catalog(?=[A-Z_.-])/g, '$1lspp');
}
module.exports = { releasePath, authoringPath };

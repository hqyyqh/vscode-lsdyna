'use strict';

function isPositiveIntegerIdentity(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function isLabelIdentity(value) {
    return typeof value === 'string' && value.length > 0;
}

function isEntityIdentity(value) {
    return isPositiveIntegerIdentity(value) || isLabelIdentity(value);
}

function entityIdentityEquals(left, right) {
    return typeof left === typeof right && left === right && isEntityIdentity(left);
}

function entityIdentityKey(value) {
    if (isPositiveIntegerIdentity(value)) return `n:${value}`;
    if (isLabelIdentity(value)) return `s:${value}`;
    return null;
}

module.exports = {
    entityIdentityEquals,
    entityIdentityKey,
    isEntityIdentity,
    isLabelIdentity,
    isPositiveIntegerIdentity,
};

export {};

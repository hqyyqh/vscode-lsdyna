import { createHash } from 'crypto';
const table = require('../../../keywords/runtime/native-readers/descriptor-identities.json');
if (createHash('sha256').update(JSON.stringify(table)).digest('hex') !== '048ed9e4da46bf45b844ae12887465f64454be58546ef0800a0d555e97ea1962') throw new Error('Descriptor identity table integrity mismatch');
export function isDescriptorIdentity(value: unknown, _ignoreHexCase = false): value is string { return typeof value === 'string' && /^record:[a-f0-9]{24}:[a-f0-9]{24}$/.test(value); }
export function descriptorIdentityGroup(value: string): string { return isDescriptorIdentity(value) ? 'group-' + value.split(':')[1] : ''; }
export function descriptorIdentityAt(base: string, index: number): string { const cards = table.cardSets[base]; if (!Number.isSafeInteger(index) || index < 0 || !cards || index >= cards.length) throw new Error('Invalid descriptor identity offset'); return cards[index]; }

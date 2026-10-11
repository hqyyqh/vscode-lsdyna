import { createHash } from 'crypto';
const table = require('../../../keywords/runtime/native-readers/descriptor-identities.json');
if (createHash('sha256').update(JSON.stringify(table)).digest('hex') !== 'e9c998020549b3c44c6c287efb6d52e8bf32f5f6e25d06783f5633434babf859') throw new Error('Descriptor identity table integrity mismatch');
export function isDescriptorIdentity(value: unknown, _ignoreHexCase = false): value is string { return typeof value === 'string' && /^record:[a-f0-9]{24}:[a-f0-9]{24}$/.test(value); }
export function descriptorIdentityGroup(value: string): string { return isDescriptorIdentity(value) ? 'group-' + value.split(':')[1] : ''; }
export function descriptorIdentityAt(base: string, index: number): string { const cards = table.cardSets[base]; if (!Number.isSafeInteger(index) || index < 0 || !cards || index >= cards.length) throw new Error('Invalid descriptor identity offset'); return cards[index]; }

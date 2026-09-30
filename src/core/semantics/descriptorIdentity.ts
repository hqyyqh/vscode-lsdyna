import { createHash } from 'crypto';
const table = require('../../../keywords/descriptor-identities.json');
if (createHash('sha256').update(JSON.stringify(table)).digest('hex') !== '69181a69342e58499c4caf1f24501c8dec1476af9d4990c1c07df0bbdfd9bf10') throw new Error('Descriptor identity table integrity mismatch');
export function isDescriptorIdentity(value: unknown, _ignoreHexCase = false): value is string { return typeof value === 'string' && /^record:[a-f0-9]{24}:[a-f0-9]{24}$/.test(value); }
export function descriptorIdentityGroup(value: string): string { return isDescriptorIdentity(value) ? 'group-' + value.split(':')[1] : ''; }
export function descriptorIdentityAt(base: string, index: number): string { const cards = table.cardSets[base]; if (!Number.isSafeInteger(index) || index < 0 || !cards || index >= cards.length) throw new Error('Invalid descriptor identity offset'); return cards[index]; }

'use strict';
const row = values => values.map(value => String(value).padStart(10)).join('').padEnd(80);
const headers = ['mid ro e pr fit beta iter iscale', 'k e0 n c p hard a', 'crc1 cra1 crc2 cra2 crc3 cra3 crc4 cra4',
    'sig00 sig45 sig90 r00 r45 r90', 'sigxx sigyy sigxy dxx dyy dxy', 'cp t0 tref ta0',
    'a b c d p q e0mart vm0', 'ahs bhs m n eps0 hmart k1 k2', 'aopt offang p4 htflag hta htb htc htd',
    'unused unused unused a1 a2 a3', 'v1 v2 v3 d1 d2 d3 usrfail'];
function specimen(missing = false, comments = 'correct', format = 'standard') {
    const rows = [row(['', '', '', '', '1.0', '', 0, 0]), row(['', '', '', '', '', '3.0', -1]),
        row([]), row([]), row([]), row([]), row([]), row([]), row(['', '', '', 0]), row([]), row(['', '', '', '', '', '', 0])];
    return ['*KEYWORD' + (format === 'long' ? ' LONG=Y' : format === 'i10' ? ' I10=Y' : ''), '*MAT_BARLAT_YLD2000',
        ...rows.flatMap((text, index) => {
            if (missing && index === 2) return [];
            const cells = text.match(/.{10}/g);
            const data = format === 'long' ? cells.map(cell => cell.padStart(20)).join('') : format === 'comma' ? cells.map(cell => cell.trim()).join(',') : text;
            const comment = comments === 'none' ? [] : comments === 'correct' ? ['$# ' + headers[index]] :
                ['$# ' + headers[(index + 3) % headers.length], '$ 中文说明 OLD_FIELD MID FIT', '$# ' + headers[0]];
            return [...comment, data];
        }), '*END'];
}
module.exports = { specimen };

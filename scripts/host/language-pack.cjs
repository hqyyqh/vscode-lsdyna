'use strict';
const fs = require('node:fs'), path = require('node:path');

// Reuse an installed language pack without network access or changes to the user's profile.
exports.copyChineseLanguagePack = (root, extensions, cacheFile) => {
    for (const name of fs.readdirSync(extensions)) if (name.startsWith('ms-ceintl.vscode-language-pack-zh-hans-'))
        fs.cpSync(path.join(extensions, name), path.join(root, 'extensions', name), { recursive: true });
    const cache = JSON.parse(fs.readFileSync(cacheFile || path.join(extensions, 'languagepacks.json')));
    for (const pack of Object.values(cache)) for (const [id, source] of Object.entries(pack.translations)) {
        const match = String(source).match(/(ms-ceintl\.vscode-language-pack-zh-hans-[^\\/]+)[\\/](.+)$/);
        if (!match) throw Error('Unexpected language pack translation path');
        const directory = path.resolve(root, 'extensions', match[1]), target = path.resolve(directory, match[2]);
        if (!target.startsWith(directory + path.sep) || !fs.existsSync(target)) throw Error('Language pack translation missing or outside pack');
        pack.translations[id] = target;
    }
    fs.writeFileSync(path.join(root, 'profile', 'languagepacks.json'), JSON.stringify(cache));
};

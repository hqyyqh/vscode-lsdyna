'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const defaultTranslationsPath = path.join(repoRoot, 'scripts', 'data', 'field-data-zh-manual-translations.json');
const englishPath = path.join(repoRoot, 'keywords', 'field_data.json');
const localizedPath = path.join(repoRoot, 'keywords', 'field_data_zh.json');

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

function containsHan(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
}

function normalizedTranslation(value) {
    return String(value || '').trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildTranslationMap(entries) {
    const byEnglish = new Map();
    for (const [index, entry] of entries.entries()) {
        const english = normalizedTranslation(entry.english);
        const zh = normalizedTranslation(entry.zh);
        if (!english || !zh) {
            throw new Error(`Invalid translation entry at index ${index}`);
        }
        if (byEnglish.has(english) && byEnglish.get(english) !== zh) {
            throw new Error(`Conflicting translation for entry at index ${index}`);
        }
        byEnglish.set(english, zh);
    }
    return byEnglish;
}

function formatHelp(englishHelp, translatedHelp) {
    return `${englishHelp}\n${translatedHelp}`;
}

function ensureLocalizedObject(localizedParent, key) {
    if (!localizedParent[key] || typeof localizedParent[key] !== 'object' || Array.isArray(localizedParent[key])) {
        localizedParent[key] = {};
    }
    return localizedParent[key];
}

function ensureLocalizedArray(localizedParent, key) {
    if (!Array.isArray(localizedParent[key])) {
        localizedParent[key] = [];
    }
    return localizedParent[key];
}

function applyTranslationsToNode(english, localized, translations, options, pathParts = []) {
    let appliedRows = 0;
    let matchedRows = 0;
    const missing = [];

    if (Array.isArray(english)) {
        if (!Array.isArray(localized)) {
            missing.push(`${pathParts.join('.') || '<root>'}: localized node is not an array`);
            return { appliedRows, matchedRows, missing };
        }

        for (let index = 0; index < english.length; index += 1) {
            if (localized[index] === undefined) {
                localized[index] = Array.isArray(english[index]) ? [] : {};
            }
            const child = applyTranslationsToNode(english[index], localized[index], translations, options, pathParts.concat(index));
            appliedRows += child.appliedRows;
            matchedRows += child.matchedRows;
            missing.push(...child.missing);
        }
        return { appliedRows, matchedRows, missing };
    }

    if (!english || typeof english !== 'object') {
        return { appliedRows, matchedRows, missing };
    }

    if (!localized || typeof localized !== 'object' || Array.isArray(localized)) {
        missing.push(`${pathParts.join('.') || '<root>'}: localized node is not an object`);
        return { appliedRows, matchedRows, missing };
    }

    if (typeof english.h === 'string' && english.h.trim()) {
        const translatedHelp = translations.get(english.h);
        const fieldName = typeof english.n === 'string' ? ` (${english.n})` : '';
        const jsonPath = `${pathParts.join('.') || '<root>'}.h${fieldName}`;
        if (translatedHelp) {
            matchedRows += 1;
            const currentHelp = typeof localized.h === 'string' ? localized.h : '';
            if (options.force || !containsHan(currentHelp)) {
                localized.h = formatHelp(english.h, translatedHelp);
                appliedRows += 1;
            }
        } else if (options.requireComplete && !containsHan(localized.h)) {
            missing.push(`${jsonPath}: missing manual translation`);
        }
    }

    for (const [key, value] of Object.entries(english)) {
        if (key === 'h') {
            continue;
        }
        if (Array.isArray(value)) {
            const nextLocalized = ensureLocalizedArray(localized, key);
            const child = applyTranslationsToNode(value, nextLocalized, translations, options, pathParts.concat(key));
            appliedRows += child.appliedRows;
            matchedRows += child.matchedRows;
            missing.push(...child.missing);
        } else if (value && typeof value === 'object') {
            const nextLocalized = ensureLocalizedObject(localized, key);
            const child = applyTranslationsToNode(value, nextLocalized, translations, options, pathParts.concat(key));
            appliedRows += child.appliedRows;
            matchedRows += child.matchedRows;
            missing.push(...child.missing);
        }
    }

    return { appliedRows, matchedRows, missing };
}

function applyManualTranslations({
    translationsPath = defaultTranslationsPath,
    requireComplete = false,
    force = false,
} = {}) {
    const translations = buildTranslationMap(loadJson(translationsPath));
    const english = loadJson(englishPath);
    const localized = loadJson(localizedPath);
    const result = applyTranslationsToNode(english, localized, translations, { requireComplete, force });

    if (requireComplete && result.missing.length > 0) {
        const preview = result.missing.slice(0, 20).join('\n');
        throw new Error(`Missing ${result.missing.length} manual translations:\n${preview}`);
    }

    writeJson(localizedPath, localized);
    return {
        appliedRows: result.appliedRows,
        matchedRows: result.matchedRows,
        translations: translations.size,
        missing: result.missing.length,
    };
}

function main() {
    const requireComplete = process.argv.includes('--require-complete');
    const force = process.argv.includes('--force');
    const result = applyManualTranslations({ requireComplete, force });
    console.log(`Loaded ${result.translations} manual translations.`);
    console.log(`Matched ${result.matchedRows} help rows.`);
    console.log(`Applied ${result.appliedRows} help rows.`);
    console.log(`Missing translations: ${result.missing}.`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = {
    applyManualTranslations,
};

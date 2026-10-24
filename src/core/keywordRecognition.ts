import { loadKeywordSchema, lookupKeywordSchema, type KeywordSchema } from './keywordSchema';
import { stripKeywordInputFormatMarker } from './parser/inputFormat';
const { getAliases } = require('./keywordUtils');

let snippetNames: ReadonlySet<string> = new Set();

export function setKnownKeywordSnippets(names: ReadonlySet<string>): void {
    snippetNames = names;
}

/** Name recognition grants neither a field layout nor permission to edit. */
export function isBuiltInKeywordName(raw: string, schema: KeywordSchema = loadKeywordSchema(() => 'en')): boolean {
    const name = stripKeywordInputFormatMarker(String(raw || '').trim().toUpperCase().replace(/^\*/, ''));
    if (!/^[A-Z0-9][A-Z0-9_+\/-]*$/.test(name) || /[+%\-]$/.test(name)) return false;
    if (/^CASE_(BEGIN|END)_\d+$/.test(name) || snippetNames.has(name) || lookupKeywordSchema(name, schema)) return true;
    if (require("./semantics/catalogNativeFileLayout").isVerifiedNativeKeyword(name)) return true;
    return getAliases(name).some(alias => snippetNames.has(alias) || !!schema[alias]);
}

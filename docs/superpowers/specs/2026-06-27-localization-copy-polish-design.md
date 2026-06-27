# Localization Copy Polish Design

## Problem Description

The extension now supports runtime language switching for English and Simplified Chinese, but some user-visible strings still read like literal translations or expose mixed-language implementation terms such as `Debug`, `Hover`, `optional cards`, and `field data`. This weakens first-run comprehension for users who rely on either language.

## Scope

This pass covers extension user-visible text that appears while the plugin is running:

- Runtime strings in `src/core/i18n.ts`.
- Static VS Code contribution strings in `package.nls.json` and `package.nls.zh-cn.json`.
- Tests that protect the polished wording from regressing.

This pass does not cover README, CHANGELOG, development docs, script logs, test titles, command IDs, LS-DYNA keywords, field names, file extensions, or internal debug output.

## Copy Principles

- Keep domain terms stable when they are the term users search for: LS-DYNA, VS Code, SumatraPDF, Tab, CodeLens, `*INCLUDE`.
- Translate explanatory UI words naturally in each language instead of leaving English fragments in Chinese copy.
- Prefer action-oriented labels for commands and buttons.
- Avoid abstract wording in errors; tell the user what happened and what context matters.
- Keep punctuation native to the language where it is part of sentence copy.

## Acceptance Criteria

- Known mixed-language Chinese phrases are removed from runtime and NLS text.
- Known awkward English phrases are replaced with clearer product copy.
- Locale key parity remains intact.
- Existing extension behavior is unchanged beyond displayed text.


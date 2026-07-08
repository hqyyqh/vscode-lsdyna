# Runtime i18n Coverage Design

## Problem Description

The extension already has static VS Code NLS files and a runtime `src/core/i18n.ts` manager, but several runtime user-facing strings still appear in English or fall back to missing keys. This creates a mixed-language onboarding experience when users set `lsdyna.language` to `zh-cn` or use a Chinese VS Code display language.

## Scope

This change covers only plugin runtime user-visible text:

- VS Code notifications, warnings, errors, QuickPick placeholders, OpenDialog labels, diagnostics, CodeLens titles, completion details/documentation, tree view progress, and hover Markdown shown by the extension.
- Runtime hover text in LS-DYNA field reference previews, including definition links, scan prompts, duplicate-definition warnings, table labels, preview alt text, and row omission notes.
- Runtime messages shown when include files, keyword jumps, manual links, or reference definitions cannot be opened.

This change does not cover README, CHANGELOG, development docs, script logs, test names, internal debug logs, generated LS-DYNA keyword names, field identifiers, file extensions, command IDs, VS Code context keys, or LS-DYNA card contents.

## Proposed Solution

Use the existing runtime i18n manager as the single source of truth for runtime UI strings:

1. Add missing bilingual keys to `src/core/i18n.ts`, including `scannedFilesProgress`.
2. Replace hardcoded runtime English strings in `src/extension.ts`, `src/core/references/fieldReferenceHover.ts`, and related runtime helpers with `i18n.get(...)`.
3. Keep LS-DYNA technical identifiers unchanged. Examples that should remain untranslated include `*DEFINE_CURVE`, `LCSS`, `curve ID`, `table ID`, file paths, keyword names, and field names.
4. Ensure language changes continue to hot-reload through the existing `lsdyna.language` configuration listener.

## Candidate Runtime Gaps

The first implementation pass should cover these known gaps:

- Missing `scannedFilesProgress` key used by include tree and keyword index scanning progress.
- Field reference hover text:
  - `Open definition`, `Open child ...`
  - `reference`, `Raw value`
  - negative switch note
  - no matching definition warning
  - scan include tree prompt
  - duplicate definitions warning
  - omitted definitions and omitted rows notes
  - curve/table preview alt text
  - `value` table header
- Field hover section title `Card Columns`.
- Diagnostics:
  - line length warning
  - missing include diagnostic
  - circular include diagnostic
  - include path length is already localized and should remain so.
- User-facing command errors:
  - cannot rename this symbol
  - not on any keyword
  - unsupported include keyword
  - no file to jump to
  - target include file not found
  - no next or previous keyword found
  - failed to open, split open, or reveal include file/folder.
- Completion documentation:
  - field comment completion detail and documentation
  - row card template documentation.

## Testing Strategy

Add or update focused tests that verify behavior rather than implementation details:

- Runtime i18n dictionary parity: every `i18n.get(...)` key used under `src/` exists in both `zh-cn` and `en`.
- `scannedFilesProgress` resolves in both languages.
- Field reference hover renders Chinese labels when `lsdyna.language` is `zh-cn` and English labels when `en`.
- Project diagnostics use the selected runtime language.
- Field completion detail/documentation uses the selected runtime language.
- Existing English assertions should be updated to use `i18n.get(...)` or explicitly set language to `en`.

## Verification Plan

- Run `npm test`.
- Run `npm run compile`.
- Manually inspect `rg` results for known hardcoded runtime phrases to confirm the intended strings are either localized or intentionally excluded.


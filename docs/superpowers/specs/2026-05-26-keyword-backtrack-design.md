# Specification: Keyword Backtrack Logic for Hover Manuals

## 1. Goal Description

When hovering over a keyword or its fields in an LS-DYNA deck, the bottom manual links/help bar currently does not support prefix/backtracking fallback matching. For example, if there is no bookmark for `*ELEMENT_MASS_PART_SET`, the manual link will fail to show even if there is a match for `*ELEMENT_MASS_PART`, `*ELEMENT_MASS`, or `*ELEMENT`.

This specification introduces:
- **Keyword Prefix Backtracking**: Falls back step-by-step to shorter prefixes by splitting on `_` when matching keywords in the manual indexer.
- **Conditional Bottom Help Bar Display**: In the hover popup, if the manuals directory is configured but no matching manual bookmark is found (even after backtracking), the bottom manual section (the divider `---` and settings gear) is completely hidden.

## 2. Component Specifications

### 2.1 manualIndexer.js

Modify `getManualLocations(kwName)`:
- Retrieve locations for the fully-qualified normalized keyword.
- If not found, split the keyword by `_`.
- Backtrack step-by-step by dropping the last token (e.g. `*ELEMENT_MASS_PART_SET` -> `*ELEMENT_MASS_PART` -> `*ELEMENT_MASS` -> `*ELEMENT`) and checking `keywordMap` for matches.
- Return the first match found, or an empty array if all match attempts fail.

### 2.2 extension.js

Modify `appendManualLinks(md, kwName)`:
- Check if the manuals directory is configured.
- If not configured (`!manualsDir || fileCount === 0`), append the guide configuration prompt and the `---` divider.
- If configured and `manuals.length > 0`, append the list of matching manuals and the `---` divider.
- If configured but `manuals.length === 0`, do nothing (completely hiding the bottom manual section).

## 3. Verification Plan

### Automated Tests
- Run `npm test` to ensure all existing tests remain green.
- Add test coverage in `test/extension.test.js` or `test/core/manualIndexer.test.js` verifying keyword backtracking and hover rendering behavior for missing manuals.

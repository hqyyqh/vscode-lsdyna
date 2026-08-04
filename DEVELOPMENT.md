# DynaSense Development Guide

## Environment

- Node.js 22
- Python 3.12 or newer
- VS Code for Extension Development Host tests

Install exactly the locked dependencies:

```bash
npm ci
```

Use `dev` as the normal integration branch. `master` is the stable release branch
and should receive only reviewed, fully green changes from `dev`. Feature branches
and worktrees are temporary and should be deleted after merge.

## Local checks

```bash
npm run check:contracts
npm test
npm run test:webview
python -m unittest discover -s keywords/tests -p "test_*.py" -v
python keywords/validate_field_data_translation.py --check-content
python keywords/audit_field_data_quality.py
npm audit --omit=dev
npm run check:package-contents
```

The Python schema-adapter tests require the frozen PyDYNA checkout described
below. Put it at the ignored local path `pydyna/`, or set
`PYDYNA_CODEGEN_DIR` to that checkout's `codegen` directory. CI checks out the
same pinned commit explicitly; it never follows the mutable branch head.

The last three commands are release gates, not advisory reports. A non-zero exit
means the branch is not ready for `dev` collaboration or `master` release.

Build the installable extension with:

```bash
npm run package
```

## PyDYNA keyword artifacts

The English keyword schema is generated from a clean external checkout of
`ansys/pydyna`. Do not vendor that checkout into this repository.

Current frozen source:

- commit: `367fea6c13ca7c8d2e28bd290d943395d84e77a3`
- reference at freeze time: `origin/feat/new-kwd`
- describe: `v0.3.2-921-g367fea6c`

The authoritative source metadata and hashes are stored in
`keywords/pydyna-source.json`. The inputs are:

- `<pydyna-root>/codegen/kwd.json`
- `<pydyna-root>/codegen/manifest.json`
- `<pydyna-root>/codegen/additional-cards.json`
- `<pydyna-root>/src/ansys/dyna/core/keywords/keyword_classes/manual/**`

Set a local root without writing it into tracked files:

```powershell
$pydynaRoot = 'C:\path\to\clean-pydyna-checkout'
$pydynaCommit = '367fea6c13ca7c8d2e28bd290d943395d84e77a3'

node scripts\regenerate-keyword-artifacts.cjs `
  --codegen-dir (Join-Path $pydynaRoot 'codegen') `
  --pydyna-commit $pydynaCommit `
  --verify-determinism

node scripts\regenerate-keyword-artifacts.cjs `
  --codegen-dir (Join-Path $pydynaRoot 'codegen') `
  --pydyna-commit $pydynaCommit
```

The source checkout must have the requested HEAD, a clean worktree, and an
`ansys/pydyna` origin. The command validates in a staging directory and atomically
publishes exactly four tracked outputs:

- `snippets/lsdyna.json`
- `keywords/field_data.json`
- `keywords/field_reference_index.json`
- `keywords/pydyna-source.json`

Run the publish command a second time and require identical hashes. Provenance
must contain the upstream commit, input hashes, output hashes, and generation-tool
hashes, but never a local absolute path.

## Chinese field help after a PyDYNA update

The authoring inputs are `keywords/field_data.json` and
`keywords/field_data_zh.json`. The generated runtime output is
`out/runtime/field_help_zh.delta.json.gz`.

Before regenerating English artifacts, save the previous English JSON outside the
repository. After generation, synchronize only translations whose complete English
source is unchanged:

```powershell
$previousEnglish = Join-Path $env:TEMP 'field_data.before-update.json'
Copy-Item keywords\field_data.json $previousEnglish

# Run the two PyDYNA commands from the previous section.

python keywords\validate_field_data_translation.py `
  --sync `
  --previous-english $previousEnglish

python keywords\validate_field_data_translation.py --check-content
python keywords\audit_field_data_quality.py
npm run build:field-help-delta
```

New, changed, or ambiguous English text deliberately falls back to English and
must be reviewed before the quality gates can pass. The full Chinese authoring JSON
is not included in the VSIX; the hash-bound compressed delta is generated during
compile/package. See `docs/field-data-zh-translation-guide.md` for the data and
quality contract.

## Tracked-source policy

Do not commit plans, reports, agent instructions, review batches, dashboards,
queues, dry runs, local absolute paths, caches, or other process artifacts. Keep
only product source, tests, reproducible generators, final authoring data, and
stable maintenance documentation.

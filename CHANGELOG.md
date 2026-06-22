# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.8] - 2026-06-22

### Added
- **Quality**: Added CI-enforced contracts for manifest settings, activation events, localization parity, README defaults, command registration, and strict UTF-8 documentation.
- **Diagnostics**: Added an explicit `include-path-too-long` diagnostic for LS-DYNA Include paths beyond the confirmed three-line/236-character limit.

### Changed
- **Parser**: Unified indented and mixed-case keyword recognition across Include, block, keyword, parameter, and navigation paths; large-file tail scans now report real line numbers.
- **Workspace**: Watchers now include `.asc` and valid configured extensions, rebuild on configuration changes, and refresh projects when previously missing Include files appear.
- **Diagnostics**: Project diagnostics are merged by project root, so refreshing one root no longer removes another root's shared-file diagnostics; stale document diagnostics are cleared.
- **Docs**: Restored 61 corrupted Superpowers records from strict UTF-8 Git history and aligned both READMEs with all 11 manifest settings.

### Security
- **Windows**: Replaced shell-built PDF and Explorer commands with parameterized `spawn` (`shell: false`) and VS Code's `revealFileInOS`/`openExternal` APIs.

## [3.0.7] - 2026-06-20
### Added
- **Features**: Added i18n support and a setup guide dialogue for configuring the PDF manual directory (`configureManualsDir`).
- **Features**: Enhanced keyword hover messages with a direct setup guide link for the PDF manual.
- **CI/CD**: Auto-tagging and streamlined dual marketplace releases (Open VSX and VS Code Marketplace).
- **CI/CD**: Upgraded GitHub Actions runtime to Node 24.
- **Docs**: Added PDF manual setup instructions and Open VSX marketplace badges to README.

### Changed
- **Tests**: Renamed `phase7_features.test.js` to `advanced_features.test.js` and updated related references.

## [3.0.6] - 2026-06-20
### Added
- **Assets**: Switched to brand new DynaSense extension icons and refined the activity bar icon.

### Fixed
- **Editor**: Added a custom tooltip to `*INCLUDE_PATH` DocumentLinks to override the default confusing "Execute Command" tooltip.

## [3.0.5] - 2026-06-18
### Changed
- **Enhancement**: Continuous improvements and bug fixes for LS-DYNA syntax parsing and language features.

## [3.0.4] - 2026-06-17
### Changed
- **Enhancement**: Core IntelliSense engine updates and stability improvements.

*(Older versions are not listed here but can be found in the git commit history.)*

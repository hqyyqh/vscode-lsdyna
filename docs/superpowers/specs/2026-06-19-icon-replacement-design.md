# DynaSense Icon Replacement Design

## Goal

Replace the extension marketplace icon and Activity Bar icon with the supplied DynaSense artwork while preserving recognizability, meeting VS Code icon guidance, and avoiding unrelated behavior changes.

## Assets and Naming

- Add `images/extension-icon.png` as the extension marketplace and README icon.
- Add `images/activitybar-icon.svg` as the custom Activity Bar view-container icon.
- Remove the superseded `images/LS_DYNA_geo_metro.png` and `images/lsdyna.png` after all references are migrated.
- Keep `images/ls.svg`; it is the unrelated file-type icon for LS-DYNA documents.

## Main Extension Icon

Use the supplied `主图�?(1)_看图�?png` artwork without redesigning its finite-element mesh, color gradient, or material-card motif. Normalize it onto a square transparent canvas at no less than 256 × 256 pixels, preserve its aspect ratio, center it optically, and retain enough edge clearance to avoid clipping in Marketplace and README presentation.

The material-card lettering is decorative at small sizes; correctness is judged by the recognizable mesh-and-card silhouette rather than text legibility at 32 pixels.

## Activity Bar Icon

Use the supplied `侧边栏扩展图标_看图�?png` as the shape reference, not as the shipped file. Recreate its finite-element arch and small material-card motif as a centered, single-color SVG with a 24 × 24 view box. Simplify details that collapse at 24 pixels, use consistent stroke weight and filled nodes, and leave transparent negative space.

The shipped SVG must remain legible on light and dark themes and rely on VS Code's Activity Bar state styling instead of fixed brand colors.

## Reference Updates

- Change the top-level `package.json` `icon` field to `images/extension-icon.png`.
- Change `contributes.viewsContainers.activitybar[0].icon` to `images/activitybar-icon.svg`.
- Change the leading icon in `README.md` and `README_zh.md` to `images/extension-icon.png`.
- Replace the old icon allow-list entries in `.vscodeignore` with the two new asset paths.

## Validation

- Confirm the PNG is square, transparent, and at least 256 × 256.
- Confirm the SVG has a 24 × 24 view box, uses one visual color, and contains no embedded raster image.
- Search the repository for stale references to the removed icon files.
- Run the extension compile and test suite.
- Run `vsce package` and confirm both new assets are included without icon-related warnings or errors.
- Inspect the final icons at Marketplace-scale and at 24 pixels on simulated light and dark Activity Bars.

## Non-Goals

- Do not change the LS-DYNA file-type icon.
- Do not change extension functionality, localization, versioning, or release notes.
- Do not redesign the supplied brand concept beyond the technical normalization and small-size simplification described above.

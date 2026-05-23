# LS-DYNA Editor Rulers Color Optimization Design Spec

## 1. Goal

Optimize the default vertical ruler lines for the `lsdyna` language in the VS Code extension to provide a premium, highly readable, and non-distracting alignment grid for deck editing.

## 2. Proposed Design

We will update the `"editor.rulers"` setting for `[lsdyna]` in `package.json` to use:
- **Columns 10-70**: Alpha-blended translucent gray (`rgba(128, 128, 128, 0.15)`).
  - *Why*: This ensures the auxiliary grid lines are subtle, unobtrusive, and look clean on both dark and light editor themes by blending with the theme's background color.
- **Column 80**: Sophisticated Lavender Purple (`#8a5cf5`).
  - *Why*: A refined, visible warning line to demarcate the 80-character boundary without using a harsh or jarring color.

### Configuration snippet to be modified in [package.json](file:///d:/Project/vscode-lsdyna/package.json)

```json
"configurationDefaults": {
    "[lsdyna]": {
        "editor.wordWrap": "off",
        "editor.rulers": [
            { "column": 10, "color": "rgba(128, 128, 128, 0.15)" },
            { "column": 20, "color": "rgba(128, 128, 128, 0.15)" },
            { "column": 30, "color": "rgba(128, 128, 128, 0.15)" },
            { "column": 40, "color": "rgba(128, 128, 128, 0.15)" },
            { "column": 50, "color": "rgba(128, 128, 128, 0.15)" },
            { "column": 60, "color": "rgba(128, 128, 128, 0.15)" },
            { "column": 70, "color": "rgba(128, 128, 128, 0.15)" },
            {
                "column": 80,
                "color": "#8a5cf5"
            }
        ]
    }
}
```

## 3. Verification Plan

1. Verify that the syntax in `package.json` compiles.
2. Run standard suite via `npm test` to ensure there are no regressions.

# Glyph sets and codepoints

Data: Nerd Fonts v3.5.1 (2026-08-21), retrieved 2026-08-28. Source: upstream `glyphnames.json` (bundled as [`../data/glyphs.tsv`](../data/glyphs.tsv)); set names and upstream projects from `src/glyphs/README.md` and the wiki page "Glyph Sets and Code Points".

## Sets

| Prefix | Set | Upstream | Codepoints | Glyphs |
|---|---|---|---|---|
| `nf-cod-` | Codicons | microsoft/vscode-codicons | U+EA60 to U+EC84 (with gaps) | 540 |
| `nf-custom-` | Seti-UI + Custom | jesseweed/seti-ui and Nerd Fonts custom glyphs | U+E5FA to U+E6BB (with gaps) | 45 |
| `nf-dev-` | Devicons | vorillaz/devicons | U+E700 to U+E958 | 613 |
| `nf-extra-` | Progress indicators (Nerd Fonts extra) | Nerd Fonts | U+EE00 to U+EE0B | 12 |
| `nf-fa-` | Font Awesome | FortAwesome/Font-Awesome | U+ED00 to U+EDFF, U+EE0C to U+EFCF, U+F000 to U+F2FF | 1,818 |
| `nf-fae-` | Font Awesome Extension | AndreLZGava/font-awesome-extension | U+E200 to U+E2A9 | 170 |
| `nf-iec-` | IEC Power Symbols | unicodepowersymbol.com | U+23FB to U+23FE, U+2B58 | 5 |
| `nf-indent-` | Indent guide (custom) | Nerd Fonts | U+E621 | 2 |
| `nf-indentation-` | Indentation guide (custom) | Nerd Fonts | U+E621 | 1 |
| `nf-linux-` | Font Logos | lukas-w/font-logos | U+F300 to U+F385 | 134 |
| `nf-md-` | Material Design Icons | Templarian/MaterialDesign | U+F0001 to U+F1AF0 | 6,896 |
| `nf-oct-` | Octicons | primer/octicons | U+2665, U+26A1, U+F400 to U+F533 | 310 |
| `nf-pl-` | Powerline Symbols | powerline/powerline | U+E0A0 to U+E0A2, U+E0B0 to U+E0B3 | 9 |
| `nf-ple-` | Powerline Extra Symbols | ryanoasis/powerline-extra-symbols | U+E0A3 to U+E0D7 (with gaps) | 34 |
| `nf-pom-` | Pomicons | gabrielelana/pomicons | U+E000 to U+E00A | 11 |
| `nf-seti-` | Seti-UI | jesseweed/seti-ui | U+E600 to U+E6AA (with gaps) | 167 |
| `nf-weather-` | Weather Icons | erikflowers/weather-icons | U+E300 to U+E3E3 | 228 |
| | Total | | | 10,995 |

Notes:

- `nf-indent-` and `nf-indentation-` are three custom alias names on U+E621; treat them as part of Seti-UI + Custom.
- Font Awesome sits in three blocks; the gap U+EE00 to U+EE0B holds the progress indicators (`nf-extra-`).
- Unnamed ranges patched into every font: box drawing U+2500 to U+259F, heavy angle brackets U+276C to U+2771.
- Material Design Icons moved in release 3.0.0 from `nf-mdi-` (U+F001 to U+F847) to `nf-md-` (U+F0001 to U+F1AF0). Some icons were dropped without replacement. For an old name such as `nf-mdi-altimeter`, search the bare word `altimeter`.

## Names, classes, JSON

- Class and name pattern: `nf-<set>-<name>`; the TSV stores the name without the `nf-` prefix.
- `glyphnames.json` entry shape: `"custom-vim": {"char": "", "code": "e62b"}`; the `METADATA` entry carries `version` and `date`.
- The website stylesheet <https://www.nerdfonts.com/assets/css/webfont.css> declares `@font-face { font-family: 'NerdFontsSymbols Nerd Font' }`, the base classes `.nf`, `.nerd-font`, `.nerd-fonts`, and one rule per glyph such as `.nf-oct-mark_github:before { content: "\f408" }`.

## Lookup recipes

Cheat sheet: <https://www.nerdfonts.com/cheat-sheet>, search by bare name, copy Icon, Class, or Code.

Bundled snapshot (paths relative to the skill directory):

```bash
grep -i 'folder' data/glyphs.tsv
awk -F'\t' '$1=="md-folder"' data/glyphs.tsv
awk -F'\t' '$2=="f408"' data/glyphs.tsv
```

Which installed font contains a codepoint (fontconfig systems):

```bash
fc-list ':charset=f408' family
```

## Writing a glyph

| Where | 4-digit (`nf-oct-mark_github` U+F408) | 5-digit (`nf-md-folder` U+F024B) |
|-------|------|------|
| bash, zsh | `printf ''` | `printf '\U000f024b'` |
| Lua, Neovim | `"\u{f408}"` or `vim.fn.nr2char(0xf408)` | `"\u{f024b}"` |
| Rust | `'\u{f408}'` | `'\u{f024b}'` |
| JavaScript, TypeScript | `""` | `"\u{f024b}"` |
| Vimscript | `""` | `"\U000f024b"` |
| CSS | `content: "\f408"` | `content: "\f024b"` |
| Go | `""` | `"\U000f024b"` |
| Config files (starship, tmux, kitty) | the literal glyph `` | the literal glyph `󰉋` |

Linux GTK apps accept direct input with `Ctrl+Shift+U`, the hex code, then Enter.

## Recompute after a data refresh

From the repository root:

```bash
cargo run --manifest-path tools/nfskill/Cargo.toml -- sets
```

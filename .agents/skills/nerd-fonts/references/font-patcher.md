# font-patcher

Data: Nerd Fonts v3.5.1, retrieved 2026-08-28. Sources: upstream README "font-patcher" section and wiki "ScriptOptions".

## Requirements

- FontForge with Python bindings (`brew install fontforge`, a distro package, or the FontForge AppImage) and Python 3.
- `FontPatcher.zip` from the v3.5.1 release: the script plus `src/glyphs`. The bare script alone does not work.

## Invocation

Download `FontPatcher.zip` and run FontForge only when the user asked to patch a font and confirmed the download.

```bash
curl -fLO https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/FontPatcher.zip
unzip -q FontPatcher.zip -d FontPatcher && cd FontPatcher
fontforge -script font-patcher /path/to/MyFont.ttf --complete --outputdir out/
./font-patcher /path/to/MyFont.ttf --complete --outputdir out/
./FontForge.AppImage -script "$PWD/font-patcher" "$PWD/MyFont.ttf" -out /tmp
```

The AppImage form needs absolute paths and an explicit output directory.

Docker, no local FontForge:

```bash
docker run --rm -v "$PWD/in:/in:Z" -v "$PWD/out:/out:Z" nerdfonts/patcher --complete
docker run --rm -v "$PWD/in:/in:Z" -v "$PWD/out:/out:Z" -e "PN=10" nerdfonts/patcher --complete
docker pull nerdfonts/patcher
```

`PN` sets the number of parallel jobs (`PN=1` for a single process).

## Options

### Glyph sets

| Option | Adds |
|--------|------|
| `--complete`, `-c` | every set below (usually what you want) |
| `--codicons` | Codicons |
| `--fontawesome` | Font Awesome |
| `--fontawesomeext` | Font Awesome Extension |
| `--fontlogos` | Font Logos |
| `--material` | Material Design Icons |
| `--octicons` | Octicons |
| `--pomicons` | Pomicons |
| `--powerline` | Powerline symbols |
| `--powerlineextra` | Powerline Extra symbols |
| `--powersymbols` | IEC Power Symbols |
| `--weather` | Weather Icons |

Without a set flag the patcher adds only Seti-UI + Custom and Devicons.

### Width

| Option | Effect |
|--------|--------|
| `--mono`, `-s` | single-width icons (the Mono variant) |
| `--variable-width-glyphs` | proportional icons without overhang (the Propo variant) |
| `--single-width-glyphs` | single-width icons without forcing the font to monospace |
| `--adjust-line-height`, `-l` | make odd cell heights even |

### Naming and output

| Option | Effect |
|--------|--------|
| `--outputdir DIR`, `-out DIR` | output directory |
| `--extension EXT`, `-ext EXT` | output format, `ttf` or `otf` |
| `--name MODE` | naming source: `full`, `postscript`, `filename`, or a custom string |
| `--makegroups [N]` | family naming strategy, level 0 to 6 |
| `--careful` | keep glyphs the font already has |

### Advanced

| Option | Effect |
|--------|--------|
| `--configfile FILE` | JSON configuration for special cases |
| `--custom FONT` | add glyphs from your own symbol font |
| `--removeligs` | strip ligature tables (needs a config file) |
| `--xavgcharwidth [N]` | keep or set `xAvgCharWidth` |
| `--boxdrawing` | replace box drawing glyphs |
| `--cell OPT` | set or query cell dimensions |
| `--postprocess SCRIPT` | run a script after patching |
| `--has-no-italic` | mark the font as Oblique instead of Italic |
| `--metrics HHEA`, `--metrics TYPO`, `--metrics WIN` | vertical metrics source |
| `--quiet`, `-q`; `--debug [N]`; `--dry`; `--progressbars`, `--no-progressbars` | logging and dry run |

## Examples from the upstream README

```bash
./font-patcher Inconsolata.otf --fontawesome --octicons --pomicons
./font-patcher "Droid Sans Mono for Powerline.otf" --mono --quiet
docker run --rm -v ~/myfont/patchme:/in:Z -v ~/myfont/patched:/out:Z nerdfonts/patcher --fontawesome
```

Install the generated font like any other (see the Install section of `SKILL.md`).

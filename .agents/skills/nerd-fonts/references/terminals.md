# Terminals, editors, prompts and web

Data: Nerd Fonts v3.5.1, retrieved 2026-08-28. Sources: upstream README "Font Installation" and wiki "FAQ and Troubleshooting"; family names from `fc-list` on installed v3.5.1 fonts; settings from each tool's documentation.

## Family strings

- Regular: `<Family> Nerd Font`. Mono: `<Family> Nerd Font Mono`. Propo: `<Family> Nerd Font Propo`.
- Symbols Only: `Symbols Nerd Font` and `Symbols Nerd Font Mono`.
- `<Family>` is the patched name from [fonts.md](fonts.md): `JetBrainsMono`, `CaskaydiaCove`, `MesloLGS`, `SauceCodePro`, `BlexMono`.

## Keep your text font, add the icons

| App | How |
|-----|-----|
| Linux (fontconfig) | copy `10-nerd-font-symbols.conf` from `NerdFontsSymbolsOnly.zip` to `~/.config/fontconfig/conf.d/`, run `fc-cache -fv`; it prefers `Symbols Nerd Font` as fallback for `monospace` and every upstream family |
| kitty | `symbol_map` (below) |
| WezTerm | already bundled in the default fallback list; `font_with_fallback` (below) pins the order |
| iTerm2 | Settings > Profiles > Text > "Use a different font for non-ASCII text" > `Symbols Nerd Font Mono` |
| Ghostty | already bundled |
| VS Code | put `'Symbols Nerd Font Mono'` after your font in `editor.fontFamily` |
| Alacritty, GNOME Terminal, Konsole | no setting; the OS fallback applies (fontconfig on Linux, CoreText on macOS) |

## Alignment

Patched fonts place every icon inside the cell. Fallback symbols do not always land on the text line: upstream documents that "scaling and placement of the fallback symbols can be hit or miss". Fixes, in order of preference:

- Use the patched font (`<Family> Nerd Font Mono` when cells must stay strict).
- kitty: `modify_font baseline 2` (points; `px` and `%` suffixes work; try small positive and negative values).
- WezTerm: `config.font = wezterm.font_with_fallback({ "Your Text Font", { family = "Symbols Nerd Font Mono", scale = 0.9 } })`.

Check with a line that mixes letters and icons and look at the vertical position: `printf 'abc  󰉋 xyz\n'` (`nf-oct-git_branch` U+F418, `nf-md-folder` U+F024B).

## kitty (`~/.config/kitty/kitty.conf`)

```conf
font_family      JetBrainsMono Nerd Font
bold_font        auto
italic_font      auto
bold_italic_font auto
```

Keep another text font and route the Nerd Fonts ranges to the symbols font:

```conf
font_family Your Text Font
symbol_map U+E000-U+E00A,U+E0A0-U+E0D7,U+E200-U+E2A9,U+E300-U+E3E3,U+E5FA-U+E6BB,U+E700-U+E958,U+EA60-U+EC84,U+ED00-U+F2FF,U+F300-U+F385,U+F400-U+F533,U+F0001-U+F1AF0 Symbols Nerd Font Mono
```

Check with `kitty +list-fonts | grep -i nerd` and `kitty --debug-font-fallback`.

## Alacritty (`alacritty.toml`)

```toml
[font]
size = 13

[font.normal]
family = "JetBrainsMono Nerd Font"
style = "Regular"
```

## WezTerm (`wezterm.lua`)

```lua
local wezterm = require("wezterm")
local config = wezterm.config_builder()
config.font = wezterm.font_with_fallback({ "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono" })
return config
```

## Ghostty (`config`)

```ini
font-family = "JetBrainsMono Nerd Font"
```

## iTerm2

Settings > Profiles > Text > Font > `JetBrainsMono Nerd Font`. Restart iTerm2 after installing a font.

## Windows Terminal (`settings.json`)

```json
{
  "profiles": {
    "defaults": {
      "font": { "face": "JetBrainsMono Nerd Font" }
    }
  }
}
```

## GNOME Terminal, Konsole

- GNOME Terminal: Preferences > profile > Text > uncheck "Use the system fixed width font" > Custom font.
- Konsole: Settings > Edit Current Profile > Appearance > Font.

## VS Code (`settings.json`)

```json
{
  "editor.fontFamily": "'JetBrainsMono Nerd Font', 'Symbols Nerd Font Mono', monospace",
  "terminal.integrated.fontFamily": "JetBrainsMono Nerd Font"
}
```

## Neovim

- In a terminal, Neovim uses the terminal font: fix the terminal first, then plugins such as nvim-web-devicons, nvim-tree and lualine render.
- Neovide: `vim.o.guifont = "JetBrainsMono Nerd Font:h14"`.
- Test in the shell before touching the editor: `printf '  󰉋\n'` (`nf-custom-vim` U+E62B, `nf-oct-git_branch` U+F418, `nf-md-folder` U+F024B).

## tmux, ssh, containers

The font belongs to the local terminal emulator. Nothing to install on the remote side or in the container. tmux status strings accept literal glyphs.

## Prompt tools

| Tool | Command or setting |
|------|--------------------|
| starship | `starship preset nerd-font-symbols -o ~/.config/starship.toml`; custom modules use the literal glyph, for example `symbol = " "` (`nf-oct-git_branch` U+F418) |
| powerlevel10k | `p10k configure` asks whether Nerd Font icons render and recommends its bundled `MesloLGS NF` |
| oh-my-posh | `oh-my-posh font install meslo` (pick another name from `oh-my-posh font list`); themes use literal glyphs |

## Web

Hot-linked stylesheet (prototyping):

```html
<link rel="stylesheet" href="https://www.nerdfonts.com/assets/css/webfont.css">
<i class="nf nf-fa-heart" aria-hidden="true"></i>
<button type="button" aria-label="Star this repository"><i class="nf nf-oct-star" aria-hidden="true"></i></button>
```

Self-hosted (production):

```css
@font-face {
  font-family: "Symbols Nerd Font";
  src: url("/fonts/SymbolsNerdFont-Regular.ttf") format("truetype");
  font-display: swap;
}
.nf { font-family: "Symbols Nerd Font"; font-style: normal; font-weight: normal; line-height: 1; }
.nf-oct-mark_github::before { content: "\f408"; }
```

`SymbolsNerdFont-Regular.ttf` and its `LICENSE` come from `NerdFontsSymbolsOnly.zip`; ship both. Decorative icons get `aria-hidden="true"`; icon-only controls get an accessible name.

Alignment: the webfont class already sets `line-height: 1`; add `vertical-align` and tune it against your text font, or center icons in flex containers.

```css
.nf { line-height: 1; vertical-align: -0.125em; }
.icon-button { display: inline-flex; align-items: center; gap: 0.5em; }
```

Check a line that mixes text and icons before shipping.

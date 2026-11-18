# Patched fonts

Data: Nerd Fonts v3.5.1 (2026-08-21), retrieved 2026-08-28. Sources: release assets from `gh api repos/ryanoasis/nerd-fonts/releases/latest`; family names and RFN flags from the upstream README "Patched Fonts" table; Homebrew casks from `brew search --cask nerd-font`; Scoop packages from the `matthewjberger/scoop-nerd-fonts` bucket; versions and notes from <https://www.nerdfonts.com/font-downloads>.

## Downloads

- Release v3.5.1, any asset: `https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/<Asset>.zip` or `<Asset>.tar.xz` (smaller)
- Checksums: `SHA-256.txt` in every release
- Patcher: `FontPatcher.zip`
- Symbols only: `NerdFontsSymbolsOnly.zip` with `SymbolsNerdFont-Regular.ttf`, `SymbolsNerdFontMono-Regular.ttf`, `10-nerd-font-symbols.conf`, `LICENSE`, `README.md`

## Family names

- Patched fonts are named `<PatchedName> Nerd Font`, `<PatchedName> Nerd Font Mono`, `<PatchedName> Nerd Font Propo`.
- Files: `<PatchedName>NerdFont-<Style>.ttf`, `<PatchedName>NerdFontMono-<Style>.ttf`, `<PatchedName>NerdFontPropo-<Style>.ttf`. Short PostScript forms: `NF`, `NFM`, `NFP`.
- Fonts with a Reserved Font Name (RFN) get a new name when patched: use the "Patched family" column, never the original name, in terminal and editor settings.
- One asset can hold several families, for example `Meslo` contains `MesloLGS`, `MesloLGM`, `MesloLGL` and their `DZ` variants; `Monaspace` contains five `Monaspice` families. Check `fc-list : family | grep -i 'nerd font'` after installing.

## Package name patterns

| Manager | Pattern | Verify |
|---------|---------|--------|
| Homebrew (macOS, Linux with `--cask`) | `font-<kebab-patched-name>-nerd-font` | `brew search --cask nerd-font` |
| Scoop (Windows) | `<Asset>-NF` after `scoop bucket add nerd-fonts` | `scoop search -NF` |
| Chocolatey (Windows, community) | `nerd-fonts-<lowercase asset>`, for example `nerd-fonts-hack` | `choco search nerd-fonts` |
| Arch Linux (Extra) | `ttf-<name>-nerd`, for example `ttf-jetbrains-mono-nerd`; `nerd-fonts` installs all | `pacman -Ss nerd` |

## Families

| Release asset | Patched family | Original font | RFN rename | Homebrew cask | Scoop | Upstream version | Notes |
|---|---|---|---|---|---|---|---|
| `0xProto` | `0xProto Nerd Font` | 0xProto | no | `font-0xproto-nerd-font` | `0xProto-NF` | 2.502 | A programming font focused on source code legibility |
| `3270` | `3270 Nerd Font` | 3270 | no | `font-3270-nerd-font` | `3270-NF` | 3.0.1 | Derived from the x3270 font, a modern format of a font with high nostalgic value |
| `AdwaitaMono` | `AdwaitaMono Nerd Font` | Adwaita Mono | no | `font-adwaita-mono-nerd-font` | `AdwaitaMono-NF` | 34.1 | The monospace typeface for GNOME |
| `Agave` | `Agave Nerd Font` | Agave | no | `font-agave-nerd-font` | `Agave-NF` | 38 | A small, monospace, outline font that is geometrically regular and simple |
| `AnnotationMono` | `AnnotationMono Nerd Font` | Annotation Mono | no | `font-annotationmono-nerd-font` | not in bucket | 0.4 | Idealized handwriting; legibility maximized while retaining hand-written character |
| `AnonymousPro` | `AnonymicePro Nerd Font` | Anonymous Pro | yes | `font-anonymice-nerd-font` | `AnonymousPro-NF` | 1.002 | Inspired by Anonymous 9 on Macintosh, since 2009, distinct `O`, `0`, `I`, `l`, `1` |
| `Arimo` | `Arimo Nerd Font` | Arimo | no | `font-arimo-nerd-font` | `Arimo-NF` | 1.33 | Metrically similar to Arial, pan-European WGL character set, sans serif |
| `AtkinsonHyperlegibleMono` | `AtkynsonMono Nerd Font` | Atkinson Hyperlegible Mono | yes | `font-atkynson-mono-nerd-font` | `AtkinsonHyperlegibleMono-NF` | 2.001 | A monospaced font designed to improve legibility and readability for individuals with low vision |
| `AurulentSansMono` | `AurulentSansMono Nerd Font` | Aurulent Sans Mono (Stephen G. Hartke) | no | `font-aurulent-sans-mono-nerd-font` | `AurulentSansMono-NF` | - | Sans serif, designed by Stephen G. Hartke which also created Verily Serif |
| `BigBlueTerminal` | `BigBlueTerminal Nerd Font` | BigBlueTerminal (VileR) | no | `font-bigblue-terminal-nerd-font` | `BigBlueTerminal-NF` | - | Nostalgic, closely based on IBM's 8x14 EGA/VGA charset |
| `BitstreamVeraSansMono` | `BitstromWera Nerd Font` | Vera Sans Mono (Bitstream Inc) | yes | `font-bitstream-vera-sans-mono-nerd-font` | `BitstreamVeraSansMono-NF` | 1.1 | Dotted zero, compact lowercase characters |
| `CascadiaCode` | `CaskaydiaCove Nerd Font` | Cascadia Code | yes | `font-caskaydia-cove-nerd-font` | `CascadiaCode-NF` | 2407.24 | A fun, new monospaced font that includes programming ligatures and is designed to enhance the modern look and feel of the Windows Terminal |
| `CascadiaMono` | `CaskaydiaMono Nerd Font` | Cascadia Mono | yes | `font-caskaydia-mono-nerd-font` | `CascadiaMono-NF` | 2407.24 | Like Cascadia Code but without any ligatures |
| `CodeNewRoman` | `CodeNewRoman Nerd Font` | Code New Roman (Sam Radian) | no | `font-code-new-roman-nerd-font` | `CodeNewRoman-NF` | 2.0 | Tunable, slashed zeros, compact smaller characters |
| `ComicShannsMono` | `ComicShannsMono Nerd Font` | Comic Shanns Mono | no | `font-comic-shanns-mono-nerd-font` | `ComicShannsMono-NF` | 1.3.2 | The very typeface you've been trained to recognize since childhood |
| `CommitMono` | `CommitMono Nerd Font` | Commit Mono | no | `font-commit-mono-nerd-font` | `CommitMono-NF` | 1.143 | An anonymous and neutral programming typeface |
| `Cousine` | `Cousine Nerd Font` | Cousine | no | `font-cousine-nerd-font` | `Cousine-NF` | 1.241 | Similar to Courier New with better readablitiy, dotted zeros |
| `D2Coding` | `D2Koding Nerd Font` | D2Coding | yes | `font-d2coding-nerd-font` | `D2Coding-NF` | 1.3.2 | A coding font for Koreans. This is the variant with ligatures. |
| `DaddyTimeMono` | `DaddyTimeMono Nerd Font` | DaddyTimeMono | no | `font-daddy-time-mono-nerd-font` | `DaddyTimeMono-NF` | 1.2.3 | A monospaced font for programmers and other terminal groupies |
| `DejaVuSansMono` | `DejaVuSansMono Nerd Font` | DejaVu | no | `font-dejavu-sans-mono-nerd-font` | `DejaVuSansMono-NF` | 2.37 | Dotted zero, based on the Bitstream Vera Fonts with a wider range of character |
| `DepartureMono` | `DepartureMono Nerd Font` | Departure Mono | no | `font-departure-mono-nerd-font` | `DepartureMono-NF` | 1.500 | A monospaced pixel font with a lo-fi, techy vibe |
| `DroidSansMono` | `DroidSansMono Nerd Font` | Droid Sans Mono (Ascender Corp) | no | `font-droid-sans-mono-nerd-font` | `DroidSansMono-NF` | 1.00-113 | Good for small screens or font sizes |
| `EnvyCodeR` | `EnvyCodeR Nerd Font` | Envy Code R | yes | `font-envy-code-r-nerd-font` | `EnvyCodeR-NF` | 0.79 | Fully-scalable monospaced font designed for programming and command prompts |
| `FantasqueSansMono` | `FantasqueSansMono Nerd Font` | Fantasque Sans Mono | no | `font-fantasque-sans-mono-nerd-font` | `FantasqueSansMono-NF` | 1.8.0 | "Wibbly-wobbly handwriting-like fuzziness", takes some inspiration from Inconsolata and Monaco |
| `FiraCode` | `FiraCode Nerd Font` | Fira Code | no | `font-fira-code-nerd-font` | `FiraCode-NF` | 6.2 | Programming ligatures, extension of Fira Mono font, enlarged operators |
| `FiraMono` | `FiraMono Nerd Font` | Fira Mono | no | `font-fira-mono-nerd-font` | `FiraMono-NF` | 3.206 | Mozilla typeface, dotted zero |
| `GeistMono` | `GeistMono Nerd Font` | Geist Mono | no | `font-geist-mono-nerd-font` | `GeistMono-NF` | 1.702 | Monospaced typeface designed to be used in code editors, diagrams, terminals, and other textbased interfaces where code is represented |
| `Go-Mono` | `GoMono Nerd Font` | Go-Mono | no | `font-go-mono-nerd-font` | `Go-Mono-NF` | 2.010 | Created specifically for the Go project, looks particularly clear for use with the Go language |
| `Gohu` | `Gohu Nerd Font` | Gohu TTF, Gohu | no | `font-gohufont-nerd-font` | `Gohu-NF` | 2.0 | Bitmap font, tall capitals and ascenders, small serifs |
| `GoogleSansCode` | `GoogleSansCode Nerd Font` | Google Sans Code | no | `font-googlesanscode-nerd-font` | not in bucket | 7.001 | Designed to bring clarity, readability, and a bit of Google's distinctive brand character to code |
| `Hack` | `Hack Nerd Font` | Hack | no | `font-hack-nerd-font` | `Hack-NF` | 3.003 | Dotted zero, short descenders, expands upon work done for Bitstream Vera & DejaVu, legible at common sizes |
| `Hasklig` | `Hasklug Nerd Font` | Hasklig | yes | `font-hasklug-nerd-font` | `Hasklig-NF` | 1.2 | Monospaced ligatures, makes composite glyphs (e.g. ->) more reabable, especially in Haskell |
| `HeavyData` | `HeavyDataMono Nerd Font` | HeavyData (Vic Fieger) | no | `font-heavy-data-nerd-font` | `HeavyData-NF` | 1 | Novel and unique design, dotted zero |
| `Hermit` | `Hurmit Nerd Font` | Hermit | yes | `font-hurmit-nerd-font` | `Hermit-NF` | 2.0 | Symbols stand out from common text |
| `iA-Writer` | `iM-Writing Nerd Font` | iA-Writer | yes | `font-im-writing-nerd-font` | `iA-Writer-NF` | Dec 2018 | A heavy modification of IBM Plex |
| `IBMPlexMono` | `BlexMono Nerd Font` | IBM Plex Mono | yes | `font-blex-mono-nerd-font` | `IBMPlexMono-NF` | 2.004 (6.4.0) | It's global, it's versatile and it's distinctly IBM |
| `Inconsolata` | `Inconsolata Nerd Font` | Inconsolata | no | `font-inconsolata-nerd-font` | `Inconsolata-NF` | 3.000 | Slashed zero, takes inspiration from many different fonts and glyphs, subtle curves in lowercase |
| `InconsolataGo` | `InconsolataGo Nerd Font` | InconsolataGo | no | `font-inconsolata-go-nerd-font` | `InconsolataGo-NF` | 1.013 | Inconsolata with straight quotes |
| `InconsolataLGC` | `Inconsolata LGC Nerd Font` | Inconsolata LGC | no | `font-inconsolata-lgc-nerd-font` | `InconsolataLGC-NF` | 3.000 | Slashed zero, takes inspiration from many different fonts and glyphs, subtle curves in lowercase |
| `IntelOneMono` | `IntoneMono Nerd Font` | Intel One Mono | yes | `font-intone-mono-nerd-font` | `IntelOneMono-NF` | 1.4.0 | Expressive monospaced font family built with clarity and legibility for developers |
| `Iosevka` | `Iosevka Nerd Font` | Iosevka | no | `font-iosevka-nerd-font` | `Iosevka-NF` | 34.8.0 | Narrow and horizontally tight characters, slashed zero |
| `IosevkaTerm` | `IosevkaTerm Nerd Font` | Iosevka Term | no | `font-iosevka-term-nerd-font` | `IosevkaTerm-NF` | 34.8.0 | A narrower variant focusing terminal uses: Arrows and geometric symbols will be narrow to follow typical terminal usages |
| `IosevkaTermSlab` | `IosevkaTermSlab Nerd Font` | Iosevka Term Slab | no | `font-iosevka-term-slab-nerd-font` | `IosevkaTermSlab-NF` | 34.8.0 | Narrow and horizontally tight characters, slashed zero |
| `JetBrainsMono` | `JetBrainsMono Nerd Font` | JetBrains Mono | no | `font-jetbrains-mono-nerd-font` | `JetBrainsMono-NF` | 2.304 | JetBrains official font for developers |
| `Lekton` | `Lekton Nerd Font` | Lekton | no | `font-lekton-nerd-font` | `Lekton-NF` | 34 | Very light and thin characters, sharp m's, `0` and `O` very similar |
| `LiberationMono` | `Literation Nerd Font` | Liberation | yes | `font-liberation-nerd-font` | `LiberationMono-NF` | 2.1.5 | `0` and `O` very similar, very short tight descenders |
| `Lilex` | `Lilex Nerd Font` | Lilex | no | `font-lilex-nerd-font` | `Lilex-NF` | 2.700 | Modern with ligatures |
| `MartianMono` | `MartianMono Nerd Font` | MartianMono | no | `font-martian-mono-nerd-font` | `MartianMono-NF` | 1.1.0 | Free and open-source monospaced font from Evil Martians |
| `Meslo` | `Meslo Nerd Font` | Meslo | no | `font-meslo-lg-nerd-font` | `Meslo-NF` | 1.21 | Slashed zeros, customized version of Apple's Menlo |
| `Monaspace` | `Monaspice Nerd Font` | Monaspace | yes | `font-monaspice-nerd-font` | `Monaspace-NF` | 1.400 | Five matching fonts all having 'texture healing' to improve legibility |
| `Monofur` | `Monofur Nerd Font` | Monofur (Tobias B Koehler) | no | `font-monofur-nerd-font` | `Monofur-NF` | 1.0 | Dotted zeros, slightly exaggerated curvy characters, compact characters |
| `Monoid` | `Monoid Nerd Font` | Monoid | no | `font-monoid-nerd-font` | `Monoid-NF` | 0.61 | Ligatures, distinguishable glyphs with short ascenders & descenders, large operators & punctuation |
| `Mononoki` | `Mononoki Nerd Font` | Mononoki | yes | `font-mononoki-nerd-font` | `Mononoki-NF` | 1.6 | Keeps in mind differentiation of characters and resolution sizes |
| `MPlus` | `M+ Nerd Font` | MPlus Fonts | no | `font-m+-nerd-font` | `MPlus-NF` | 1.100 | Multiple styles and weights, many glyph sets (e.g. Kana glyphs) |
| `NerdFontsSymbolsOnly` | `Symbols Nerd Font` | Nerd Fonts Symbols Only | no | `font-symbols-only-nerd-font` | not in bucket | latest | Just the Nerd Font Icons. I.e Symbol font only |
| `Noto` | `Noto Nerd Font` | Noto | no | `font-noto-nerd-font` | `Noto-NF` | div | `0` and `O` very similar, characters are either very curvy or straight lined |
| `OpenDyslexic` | `OpenDyslexic Nerd Font` | OpenDyslexic | no | `font-opendyslexic-nerd-font` | `OpenDyslexic-NF` | 2.001 | Designed specifically to alleviate reading errors caused by dyslexia |
| `Overpass` | `Overpass Nerd Font` | Overpass | no | `font-overpass-nerd-font` | `Overpass-NF` | 3.0.5 | An open source font family inspired by Highway Gothic |
| `ProFont` | `ProFont Nerd Font` | ProFont | no | `font-profont-nerd-font` | `ProFont-NF` | 2.3/2.2 | Looks best with anti-aliasing turned off, squared off character corners, vertically tight small `s` |
| `ProggyClean` | `ProggyClean Nerd Font` | ProggyClean (Tristan Grimmer) | no | `font-proggy-clean-tt-nerd-font` | `ProggyClean-NF` | 2004/04/15 | Designed particularly for use at small point sizes |
| `Recursive` | `RecMono Nerd Font` | Recursive Mono | no | `font-recursive-mono-nerd-font` | `Recursive-NF` | 1.085 | inspired by casual script signpainting, 4 variants |
| `RobotoMono` | `RobotoMono Nerd Font` | Roboto Mono | no | `font-roboto-mono-nerd-font` | `RobotoMono-NF` | 3.0 | Dashed zero, curved and straight character lines |
| `ShareTechMono` | `ShureTechMono Nerd Font` | Share Tech Mono | yes | `font-shure-tech-mono-nerd-font` | `ShareTechMono-NF` | 1.003 | Dotted zeros, distinguishable 1 and l, curved and straight character lines |
| `SourceCodePro` | `SauceCodePro Nerd Font` | Source Code Pro | yes | `font-sauce-code-pro-nerd-font` | `SourceCodePro-NF` | 2.042 | Monospaced font family for user interface and coding environments |
| `SpaceMono` | `SpaceMono Nerd Font` | Space Mono | no | `font-space-mono-nerd-font` | `SpaceMono-NF` | 1.003 | Squarish character lines, dotted zero, aggressive parethesis |
| `Terminus` | `Terminess Nerd Font` | Terminus TTF | yes | `font-terminess-ttf-nerd-font` | `Terminus-NF` | 4.49.2 | Squarish characters that are slightly askew |
| `Tinos` | `Tinos Nerd Font` | Tinos | no | `font-tinos-nerd-font` | `Tinos-NF` | 1.23 | Some similarities to Times New Roman, designed by Steve Matteson, includes pan-European WGL character set |
| `Ubuntu` | `Ubuntu Nerd Font` | Ubuntu Font | no | `font-ubuntu-nerd-font` | `Ubuntu-NF` | 1.006 / 1.100 | Refreshed version of Ubuntu and Ubuntu Mono fonts |
| `UbuntuMono` | `UbuntuMono Nerd Font` | Ubuntu Font | no | `font-ubuntu-mono-nerd-font` | `UbuntuMono-NF` | 1.006 / 1.100 | Refreshed version of Ubuntu and Ubuntu Mono fonts |
| `UbuntuSans` | `UbuntuSansM Nerd Font` | Ubuntu Sans Mono | no | `font-ubuntu-sans-nerd-font` | `UbuntuSans-NF` | 1.006 / 1.100 | Refreshed version of Ubuntu and Ubuntu Mono fonts |
| `VictorMono` | `VictorMono Nerd Font` | Victor Mono | no | `font-victor-mono-nerd-font` | `VictorMono-NF` | 1.5.6 | Clean, crisp and narrow, with a large x-height and clear punctuation |
| `ZedMono` | `ZedMono Nerd Font` | Zed Mono | no | `font-zed-mono-nerd-font` | `ZedMono-NF` | 1.2.0 | Zed Mono is a more rounded version of Iosevka |

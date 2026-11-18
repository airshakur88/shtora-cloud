# Glyph data snapshot

`glyphs.tsv` lists every named Nerd Fonts glyph: `name`, `code` (hex codepoint), `char` (the glyph). Source: `glyphnames.json` from [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts), release v3.5.1 (2026-08-21), retrieved 2026-08-28. Rows: 10,995. Data license: MIT, Copyright (c) 2014 Ryan L McIntyre (see THIRD-PARTY-NOTICES.md at the repository root); the icon sets belong to their upstream projects.

Regenerate from the repository root (replace the tag on a new release):

```bash
curl -fsSL https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.5.1/glyphnames.json -o /tmp/glyphnames.json
cargo run --manifest-path tools/nfskill/Cargo.toml -- snapshot /tmp/glyphnames.json > skills/nerd-fonts/data/glyphs.tsv
```

Without Rust: `jq -r 'del(.METADATA) | to_entries | sort_by(.key) | .[] | [.key, .value.code, .value.char] | @tsv' /tmp/glyphnames.json` after a `printf 'name\tcode\tchar\n'` header line.

`common-icons.txt` is the grouped name list for `references/common-icons.md`. Rebuild after a TSV refresh or a list edit:

```bash
cargo run --manifest-path tools/nfskill/Cargo.toml -- icons skills/nerd-fonts/data/common-icons.txt skills/nerd-fonts/references/common-icons.md
```

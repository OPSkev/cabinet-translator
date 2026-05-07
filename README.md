# Cabinet Order Translator

Web tool for E.F. San Juan that translates Shiloh / W.W. Wood Products cabinet order confirmation PDFs into plain-English line lists. Built for Lydia (Work Order Coordinator) — drop a PDF, get a printable translation.

**Live URL:** https://opskev.github.io/cabinet-translator/

## How it works

- 100% client-side (no backend, no API key)
- PDF parsed in-browser using PDF.js
- Codes looked up against `shiloh-kb.json` (compiled from `cabinet-kb/`)
- Output is the same printable HTML format used elsewhere

## Coverage

**v1:** Shiloh Cabinetry (W.W. Wood Products) — framed line, catalog v34.2.0 (Jan 2026)

**Coming:** Eclipse, Dura Supreme (Crestwood + Bria)

## Files

| File | Purpose |
|---|---|
| `index.html` | Drop zone + result viewer |
| `app.js` | PDF parsing, code lookup, render |
| `styles.css` | Print-friendly styles |
| `shiloh-kb.json` | Compiled cabinet knowledge base |

## Updating the KB

The source of truth is `C:\Users\efsj67\ksnyder\PersonalAssistant\projects\cabinet-kb\` (markdown). When that updates, regenerate `shiloh-kb.json` and push.

## Local testing

`fetch('shiloh-kb.json')` requires HTTP context — open via a local server (e.g. `python -m http.server`) or just deploy to GitHub Pages and test there.

## License

Internal use, E.F. San Juan only. KB content extracted from manufacturer catalogs for internal reference.

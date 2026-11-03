# dotaguess — GitHub Pages

The standalone browser game is in `docs/`. Publish `main` / `docs` in repository Settings → Pages. No build, server or secrets are required. The previous Node/Postgres application remains untouched.

Local preview: `python -m http.server 8765 --directory docs`.

Included: 127 heroes with local portraits, 453 ability sound questions, 15 bilingual quote questions with original English audio, attribute comparisons, random endless rounds, browser-local progress, keyboard autocomplete, reduced-motion support, live OpenDota item popularity, and parsed-match purchase timelines.

The purchase timeline shows the latest six purchases, not a reconstructed inventory. At match end it shows the exact final six inventory slots. OpenDota popularity is independent item frequency, not the frequency of a complete six-item build. API results are cached for six hours. Network errors are shown with retry controls.

Hero/ability catalog snapshot: 2026-11-03. Images and audio belong to Valve. See `docs/sources.html` for attribution and data conventions.

Validation: catalog IDs, asset references and 127 portraits checked; JavaScript syntax checked; browser checks cover autocomplete, keyboard selection, attribute comparison, win state, reload persistence, audio playback, language switch, live item popularity, and real-match timeline/final inventory.

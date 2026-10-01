# system.css (vendored)

[@sakun/system.css](https://github.com/sakofchit/system.css) v0.1.11, MIT
licensed (see `LICENSE`), with its fonts and button images, bundled so
the settings window renders the same offline and cannot change under us.

Local changes:

- `system.css`: removed the trailing `/*# sourceMappingURL=system.css.map */`
  comment. The map file is not vendored, so the reference pointed at nothing
  (and made DevTools request a missing file).

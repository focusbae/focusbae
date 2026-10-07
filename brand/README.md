# FocusBae visual mark

The selected identity is the custom italic `f.` in warm ivory on forest green. `soft.svg` is the desktop application icon. `editorial.svg` is the flat interface and website tile. `small.svg` is the heavier small-size glyph, and `tray.svg` is a monochrome transparent menu-bar source.

Run `npm run icons:generate` in this repository to regenerate the desktop PNG, ICO, ICNS, tray and renderer assets. When the sibling `focusbae-web` repository is present, the same command updates its header SVG, favicon and Apple touch icon. The generator uses local Chrome through Playwright and `iconutil` on macOS. Generated files are checked into their respective repositories so ordinary builds do not require those tools.

The app's isolated renderer allows its hashed SVG asset alongside JS, CSS and PNG files. The tray uses a template image so macOS can tint it appropriately in light and dark menu bars.

A public visual search found other `f.` marks, so the design study is not a claim of unique ownership or formal clearance.

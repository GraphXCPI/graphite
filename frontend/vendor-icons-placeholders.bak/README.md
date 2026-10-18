# Vendor icon placeholders (Track D, D1b, review round 1 / B6)

`branding/` (the sibling directory this repo would otherwise import icons
from) ships under `branding/LICENSE.txt`, a restrictive license: its Assets
("logos, icons, and branding materials") may only be used "as part of
unmodified build artifacts produced from the official Graphite repository
... on master branch commits, using the official build process." A patched,
env-var-configured fork build does not qualify.

This directory holds plain, non-representational placeholder SVGs at the
same relative paths `frontend/src/icons.ts` (and nothing else) imports, sized
correctly for each icon-set's convention (12px/16px/24px viewBox) so every
icon slot in the UI still renders something instead of a broken image -- just
not a reproduction of Graphite's actual icon artwork. `frontend/vite.config.ts`'s
Vite alias resolves `/../branding/**.svg` imports to this directory instead
of the real `branding/` one, so no source files elsewhere needed to change.

The one wordmark reference (`assets/graphics/graphite-logotype-solid.svg`,
used only in the cosmetic Welcome panel) renders as an empty, zero-size SVG
rather than a placeholder logo: Studio owns product identity end-to-end
(PRD amendment 1), so there is no reason for a Graphite wordmark -- real or
substitute -- to appear anywhere in this embed.

`branding/favicons/*` (favicons, `site.webmanifest`, `browserconfig.xml`) is
no longer copied into the built bundle at all (see the removed
`STATIC_ASSET_DIRS` entry in `vite.config.ts`) -- those files only affect a
browser tab's icon on a top-level navigation, and Studio only ever loads
this build inside a same-origin iframe, so dropping them has no visible
effect on the embedded product. Opening the build standalone (dev) simply
shows a generic browser-default tab icon instead of Graphite's.

This is a functional, honest stand-in, not a cosmetic priority: replacing
these 218 generic placeholders with a real icon set (or restoring visual
parity another way) is recorded as an open item in `TRACK-D-PINS.md`, not
silently treated as "done."

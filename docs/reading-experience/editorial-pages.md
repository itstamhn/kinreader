# Editorial kinetic pages

The reader follows the supplied editorial audiobook reference. It uses warm paper, serif text, stable line placement, and spoken words that turn darker. Desktop pages contain up to 18 words and prefer sentence endings after 10 words or clause punctuation after 12. Phone pages also have a 76-character budget to keep type readable. A short final page is allowed.

Line breaks depend on text and available layout, never the active word or incoming timing corrections. Word highlighting changes only color. The page has a fixed-height stage and a 100 ms opacity entry, disabled for reduced-motion preferences. The audio clock selects page transitions at the midpoint between the preceding word's end and the next page's first word. Arrow keys and page buttons seek through the same page groups.

Audio uses the existing saved Soniox sections and exact word timings. No new synthesis or alternate voice provider is introduced. Vietnamese glosses and the requested font-subset behavior are excluded. This update retains the app's existing Newsreader serif rather than adding another font download.

Full Text highlighting also keeps the same font weight, padding, and borders in every word state, preventing highlight-induced reflow there.

Verification includes 306 passing tests, web typecheck and production build, real saved Soniox playback, page progression, rewind to zero, and a 390-by-844 phone layout. In the browser, the first word's bounding box before and after the spoken highlight changed was exactly the same: x 422, y 238.25, width 148.203125, height 76.796875. Screenshots are saved alongside this note.

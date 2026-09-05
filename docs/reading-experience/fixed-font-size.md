# Fixed font sizes

The kinetic reader no longer derives font size from the longest line on each page. Font size and line height depend only on the selected text setting and screen breakpoint.

| Setting | Desktop | Phone |
| --- | --- | --- |
| Compact | 40px | 26px |
| Standard | 48px | 30px |
| Large | 56px | 34px |

Line height stays at 1.6. Pagination measures the loaded font at that size and fits up to three lines and 18 words per page, preserving natural punctuation boundaries where possible. An oversized token gets its own page and wraps without shrinking the surrounding text. Changing the viewport, text size, or loaded font triggers new measurements. Playback position and timestamp updates do not change font size.

Existing working-tree navigation cleanup is preserved. Keyboard arrows and buttons both use the displayed page, including during the pause between spoken words.

Validation covered measured pagination, word preservation, oversized tokens, navigation, typecheck, production build, and the web suite. Browser measurements across pages were 48px / 76.8px on desktop and 30px / 48px on a 390px phone viewport. The checked phone page had no horizontal text overflow. Saved Soniox playback advanced through pages without changing those font metrics.

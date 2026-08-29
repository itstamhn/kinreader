// An existing home-screen install still opens kinreader.com/ (the PWA manifest's
// start_url), which is now the marketing page. Send only those visitors on to
// the app; an ordinary browser visit stays here.
//
// This lives in public/ rather than as an Astro <script> because Astro inlines
// small scripts, and an inline script needs a sha256 in the CSP. A hash list
// that has to be recomputed whenever the script changes drifts, and it fails
// silently -- see the warning at the top of apps/web/public/_headers. Files in
// public/ are copied verbatim and stay external, so `script-src 'self'` covers
// this with nothing to maintain.
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
  location.replace('https://app.kinreader.com/');
}

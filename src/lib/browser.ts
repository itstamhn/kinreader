// Google refuses to run its OAuth consent screen inside an embedded WebView
// and answers with `403: disallowed_useragent` on its own error page --
// the user never comes back to us, so there is nothing we can render to
// explain it. That is the single most common way "Continue with Google" dies
// on a phone and never on a desktop: links opened from X, Instagram,
// LinkedIn, Slack or Gmail run in the host app's in-app browser, not Safari
// or Chrome.
//
// Detection is a user-agent heuristic and therefore fuzzy, so it only ever
// *adds* an explanation and an escape hatch -- the Google button stays live
// either way, and a false positive costs the user a banner, not a login.
export function isEmbeddedBrowser(userAgent: string): boolean {
  if (!userAgent) return false;

  // Named in-app browsers. `; wv)` is Android's own WebView marker.
  const namedWebView =
    /(FBAN|FBAV|FB_IAB|FBIOS|Instagram|LinkedInApp|Snapchat|Pinterest|MicroMessenger|WhatsApp|TikTok|musical_ly|Twitter|Slack|Line\/|\bwv\b)/i;
  if (namedWebView.test(userAgent)) return true;

  // iOS WKWebViews carry the platform tokens but drop the `Safari/` token.
  // Every real iOS browser keeps it, Chrome (CriOS), Firefox (FxiOS) and
  // Edge (EdgiOS) included, because they are all WebKit underneath.
  if (/(iPhone|iPad|iPod)/.test(userAgent) && !/Safari\//.test(userAgent)) return true;

  return false;
}

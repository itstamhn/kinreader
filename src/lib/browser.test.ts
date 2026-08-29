import { test, expect } from 'bun:test';
import { isEmbeddedBrowser } from './browser';

const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const CHROME_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Google answers OAuth from these with `403: disallowed_useragent` on its own
// error page, so the user never returns to us -- the only place we can warn
// them is before they leave.
const EMBEDDED = {
  instagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 336.0.0.25.90',
  facebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/468.0.0.44.107]',
  x: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone',
  linkedin:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  iosWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
};

for (const [name, ua] of Object.entries(EMBEDDED)) {
  test(`isEmbeddedBrowser detects the ${name} in-app browser`, () => {
    expect(isEmbeddedBrowser(ua)).toBe(true);
  });
}

// A false positive costs a real browser its Google button's explanation
// banner, so the negative cases matter as much as the positive ones.
for (const [name, ua] of Object.entries({
  'Safari on iOS': SAFARI_IOS,
  'Chrome on iOS': CHROME_IOS,
  'Chrome on Android': CHROME_ANDROID,
  'Chrome on desktop': CHROME_DESKTOP,
})) {
  test(`isEmbeddedBrowser leaves ${name} alone`, () => {
    expect(isEmbeddedBrowser(ua)).toBe(false);
  });
}

test('isEmbeddedBrowser handles an empty user agent', () => {
  expect(isEmbeddedBrowser('')).toBe(false);
});

export function getEnv() {
  return {
    SITE_URL: process.env.SITE_URL || 'https://app.kinreader.com',
    JWKS: process.env.JWKS,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  };
}

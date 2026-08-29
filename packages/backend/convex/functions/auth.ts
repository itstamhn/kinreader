import { convex } from 'kitcn/auth';
import { getEnv } from '../lib/get-env';
import authConfig from './auth.config';
import { defineAuth } from './generated/auth';

export default defineAuth(() => ({
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: getEnv().GOOGLE_CLIENT_ID || 'dummy-google-client-id',
      clientSecret: getEnv().GOOGLE_CLIENT_SECRET || 'dummy-google-client-secret',
    },
  },
  baseURL: getEnv().SITE_URL,
  plugins: [
    convex({
      authConfig,
    }),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24 * 15,
  },
  telemetry: { enabled: false },
  trustedOrigins: [
    getEnv().SITE_URL,
    'http://localhost:3000',
    'https://app.kinreader.com',
    'https://kinreader.com',
  ],
}));

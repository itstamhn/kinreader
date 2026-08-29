import { convex } from 'kitcn/auth';
import { magicLink } from 'better-auth/plugins';
import { getEnv } from '../lib/get-env';
import { renderMagicLinkEmail, renderWelcomeEmail, sendEmail } from '../lib/email';
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
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          if (user.email) {
            try {
              const { subject, html, text } = renderWelcomeEmail({
                email: user.email,
                name: user.name,
                appUrl: getEnv().SITE_URL || 'https://app.kinreader.com',
              });
              await sendEmail({
                to: user.email,
                subject,
                html,
                text,
              });
            } catch (err) {
              console.error('Failed to dispatch welcome email:', err);
            }
          }
        },
      },
    },
  },
  baseURL: getEnv().SITE_URL,
  plugins: [
    magicLink({
      expiresIn: 15 * 60,
      sendMagicLink: async ({ email, url }) => {
        const { subject, html, text } = renderMagicLinkEmail({ email, url });
        await sendEmail({
          to: email,
          subject,
          html,
          text,
        });
      },
    }),
    convex({
      authConfig,
      jwks: process.env.JWKS,
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

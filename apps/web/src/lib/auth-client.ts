import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';
import { convexClient } from 'kitcn/auth/client';
import { createAuthMutations } from 'kitcn/react';

const getBaseURL = () => {
  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return window.location.origin;
  }
  return import.meta.env.VITE_CONVEX_SITE_URL || 'https://notable-camel-807.convex.site';
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [convexClient(), magicLinkClient()],
});

export const {
  useSignInMutationOptions,
  useSignInSocialMutationOptions,
  useSignOutMutationOptions,
  useSignUpMutationOptions,
} = createAuthMutations(authClient);

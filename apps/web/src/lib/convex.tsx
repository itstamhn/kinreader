import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ConvexReactClient,
  createCRPCContext,
  getConvexQueryClientSingleton,
  getQueryClientSingleton,
} from 'kitcn/react';
import { ConvexAuthProvider } from 'kitcn/auth/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { api } from '@kinreader/backend/api';
import { authClient } from './auth-client';

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);

function createQueryClient() {
  return new QueryClient();
}

// kitcn's generated `api` surface + React context/hooks. `useCRPC()` is the
// entry point components use to build TanStack Query options for cRPC
// procedures (see kitcn/docs "React Query Integration").
export const { CRPCProvider, useCRPC } = createCRPCContext({
  api,
  convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL!,
});

export function ConvexAppProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClientSingleton(createQueryClient);
  const convexQueryClient = getConvexQueryClientSingleton({ convex, queryClient });

  return (
    <NuqsAdapter>
      <ConvexAuthProvider
        client={convex}
        authClient={authClient}
      >
        <QueryClientProvider client={queryClient}>
          <CRPCProvider convexClient={convex} convexQueryClient={convexQueryClient}>
            {children}
          </CRPCProvider>
        </QueryClientProvider>
      </ConvexAuthProvider>
    </NuqsAdapter>
  );
}

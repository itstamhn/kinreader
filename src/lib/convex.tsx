import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ConvexProvider,
  ConvexReactClient,
  createCRPCContext,
  getConvexQueryClientSingleton,
  getQueryClientSingleton,
} from 'kitcn/react';
import { api } from '../../convex/shared/api';

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
    <ConvexProvider client={convex}>
      <QueryClientProvider client={queryClient}>
        <CRPCProvider convexClient={convex} convexQueryClient={convexQueryClient}>
          {children}
        </CRPCProvider>
      </QueryClientProvider>
    </ConvexProvider>
  );
}

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import AuthProvider from "./auth/AuthProvider";

// One QueryClient per browser session, created lazily in state so it survives
// re-renders but is never shared across requests (Next App Router SSR-safety).
export default function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is fresh for 30s -> tab switches are instant (served from cache,
            // revalidated in the background). Retry once; auth 401s are handled by
            // the session refresh, not by hammering retries.
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  // AuthProvider sits INSIDE QueryClientProvider: auth state feeds the queries,
  // and views read both from the same tree.
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { createDataClient, type DataClient } from './client';

let browserClient: DataClient | null = null;

// Made on first use rather than on import, because the page origin only
// exists in the browser and pages are prerendered on the server.
const defaultClient: DataClient = {
  request(spec) {
    browserClient ??= createDataClient();
    return browserClient.request(spec);
  },
};

const DataClientContext = createContext<DataClient>(defaultClient);

/** Swaps the client for a subtree. Tests use it to put the fake API behind every screen. */
export function DataClientProvider({
  client,
  children,
}: {
  client: DataClient;
  children: ReactNode;
}) {
  return <DataClientContext value={client}>{children}</DataClientContext>;
}

export function useDataClient(): DataClient {
  return useContext(DataClientContext);
}

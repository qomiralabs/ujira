// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A separate entry point, so code that only needs the schemas never loads msw.

export { MOCK_VIEW_HEADER, createHandlers } from './handlers.js';
export type { MockOptions } from './handlers.js';

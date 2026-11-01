// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every v1 route the server answers. Add a route by declaring it in its own
// file under routes/ and listing it here; the OpenAPI document, the
// registry checks and the route tests all read this list.

import type { Route } from '../route.js';
import { healthRoute } from './health.js';

export const V1_ROUTES: readonly Route[] = Object.freeze([healthRoute]);

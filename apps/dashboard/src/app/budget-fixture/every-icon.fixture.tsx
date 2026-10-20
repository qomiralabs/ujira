// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as icons from 'lucide-react';

// The mistake the budget exists to catch: importing a whole library into the
// browser. Every Lucide icon ends up in this route's JavaScript.
export function EveryIcon() {
  return <p>{Object.keys(icons).length} icons</p>;
}

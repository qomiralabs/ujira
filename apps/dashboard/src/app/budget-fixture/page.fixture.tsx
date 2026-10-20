// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { EveryIcon } from './every-icon.fixture';

// Built only with UJIRA_BUDGET_FIXTURE=1, to prove the route budget fails a
// page that ships too much JavaScript. It never exists in a normal build.
export default function BudgetFixturePage() {
  return <EveryIcon />;
}

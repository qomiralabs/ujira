// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { DevelopersView } from '../../developers/developers-view';
import { sectionMetadata } from '../../shell/section-view';

export const metadata = sectionMetadata('developers');

export default function DevelopersPage() {
  return <DevelopersView />;
}

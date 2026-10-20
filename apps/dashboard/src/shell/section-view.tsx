// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Metadata } from 'next';

import { EmptyState } from '../patterns/empty-state';
import { PageHeader } from '../patterns/page-header';
import { NAV_ITEMS, type Section } from './nav';
import { PLACEHOLDERS } from './placeholders';

function item(section: Section) {
  const found = NAV_ITEMS.find((i) => i.segment === section);
  if (!found) throw new Error(`no navigation item for ${section}`);
  return found;
}

export function sectionMetadata(section: Section): Metadata {
  return { title: item(section).label };
}

/** A section before its screen is built: the title, what it is for and what will appear. */
export function SectionView({ section }: { section: Section }) {
  const nav = item(section);
  const placeholder = PLACEHOLDERS[section];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={nav.label} summary={nav.summary} />
      <EmptyState icon={nav.icon} title={placeholder.title}>
        {placeholder.body}
      </EmptyState>
    </div>
  );
}

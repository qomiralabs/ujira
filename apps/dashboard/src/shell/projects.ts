// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createSerializer, parseAsStringLiteral } from 'nuqs';

// Sample projects until the projects API lands. Every view reads the
// selected project from the URL, so a link always opens the same project.
export const PROJECTS = [
  { id: 'labelling', name: 'Labelling payouts' },
  { id: 'bounties', name: 'Bug bounties' },
  { id: 'grants', name: 'Community grants' },
] as const;

export type ProjectId = (typeof PROJECTS)[number]['id'];

export const DEFAULT_PROJECT: ProjectId = PROJECTS[0].id;

export const projectParam = parseAsStringLiteral(PROJECTS.map((p) => p.id)).withDefault(
  DEFAULT_PROJECT,
);

/** Builds a link that keeps the selected project. The default project adds nothing. */
export const withProject = createSerializer({ project: projectParam });

export function projectName(id: ProjectId): string {
  return PROJECTS.find((p) => p.id === id)?.name ?? PROJECTS[0].name;
}

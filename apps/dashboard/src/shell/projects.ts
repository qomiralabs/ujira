// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createSerializer, parseAsStringLiteral } from 'nuqs';

// Sample projects until the projects API lands. Every view reads the
// selected project from the URL, so a link always opens the same project.
// A project is named by the principal, so its name is the whole content.
// Nothing here describes it: a line under a name someone chose themselves
// would be noise.
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
  return project(id).name;
}

/** The chosen project, falling back to the default one for an unknown id. */
export function project(id: ProjectId): (typeof PROJECTS)[number] {
  return PROJECTS.find((p) => p.id === id) ?? PROJECTS[0];
}

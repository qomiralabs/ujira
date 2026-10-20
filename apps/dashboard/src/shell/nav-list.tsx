// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon } from './icon';
import { activeItem, hrefFor, NAV_ITEMS, type NavItem } from './nav';
import type { ProjectId } from './projects';
import { withProject } from './projects';

interface NavListProps {
  project: ProjectId;
  group: NavItem['group'];
  /** Collapsed rails show icons only; the label stays for assistive technology. */
  collapsed?: boolean;
  onNavigate?: () => void;
}

export function NavList({ project, group, collapsed = false, onNavigate }: NavListProps) {
  const current = activeItem(usePathname());
  return (
    <ul className="flex flex-col gap-1">
      {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
        const active = current?.segment === item.segment;
        return (
          <li key={item.segment}>
            <Link
              href={withProject(hrefFor(item), { project })}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
              onClick={() => onNavigate?.()}
              className={[
                'flex h-10 items-center gap-3 rounded-control px-3 text-body-s font-medium transition-[background-color,color] duration-150 ease-out rail-collapsed:justify-center rail-collapsed:px-0',
                active
                  ? 'bg-surface text-text chosen-outline'
                  : 'text-text-secondary hover:bg-surface/60 hover:text-text',
              ].join(' ')}
            >
              <Icon source={item.icon} className="shrink-0" />
              <span className="truncate rail-collapsed:sr-only">{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

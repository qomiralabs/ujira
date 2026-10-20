// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { Search } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';

import { CommandPalette } from './command-palette';
import { Icon } from './icon';
import { MobileNav } from './mobile-nav';
import type { ProjectId } from './projects';
import { ThemeSwitch } from './theme-switch';

interface TopBarProps {
  project: ProjectId;
  onProjectChange: (project: ProjectId) => void;
}

function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const noSubscribe = () => () => undefined;

export function TopBar({ project, onProjectChange }: TopBarProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const apple = useSyncExternalStore(noSubscribe, isApple, () => false);
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-rule bg-bg px-4 md:px-8">
      <MobileNav
        project={project}
        onProjectChange={onProjectChange}
        open={navOpen}
        onOpenChange={setNavOpen}
      />
      <button
        type="button"
        onClick={() => {
          setPaletteOpen(true);
        }}
        aria-haspopup="dialog"
        aria-keyshortcuts={apple ? 'Meta+K' : 'Control+K'}
        className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-control border border-rule bg-surface px-3 text-body-s text-text-secondary transition-colors duration-150 ease-out hover:text-text sm:max-w-sm"
      >
        <Icon source={{ lucide: Search }} size={18} className="shrink-0" />
        <span className="flex-1 truncate text-left">Go to a page</span>
        <kbd className="hidden rounded-control border border-rule px-1.5 font-mono text-label text-text-secondary sm:inline">
          {apple ? '⌘ K' : 'Ctrl K'}
        </kbd>
      </button>
      <div className="ml-auto">
        <ThemeSwitch />
      </div>
      <CommandPalette project={project} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

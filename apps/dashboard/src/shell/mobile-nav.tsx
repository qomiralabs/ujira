// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useEffect, useRef } from 'react';
import { Menu, X } from 'lucide-react';

import { Icon } from './icon';
import { Logo } from './logo';
import { NavList } from './nav-list';
import { ProjectSwitcher } from './project-switcher';
import type { ProjectId } from './projects';

interface MobileNavProps {
  project: ProjectId;
  onProjectChange: (project: ProjectId) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The navigation as a drawer below tablet width. A modal dialog traps focus,
 * closes on Escape and makes the page behind it inert.
 */
export function MobileNav({ project, onProjectChange, open, onOpenChange }: MobileNavProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const close = () => {
    onOpenChange(false);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          onOpenChange(true);
        }}
        className="grid size-10 place-items-center rounded-control text-text-secondary hover:bg-rule/50 hover:text-text md:hidden"
      >
        <Icon source={{ lucide: Menu }} />
      </button>
      <dialog
        ref={dialog}
        aria-label="Navigation"
        data-theme="dark"
        onClose={close}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === event.currentTarget) close();
        }}
        className="m-0 h-dvh max-h-dvh w-72 max-w-[85vw] border-r border-rule bg-bg p-0 text-text backdrop:bg-teal-ink/60"
      >
        <div className="flex h-full flex-col gap-4 px-3 py-4">
          <div className="flex items-center justify-between pl-2">
            <Logo variant="lockup" className="h-8 w-auto" />
            <button
              type="button"
              aria-label="Close navigation"
              onClick={close}
              className="grid size-10 place-items-center rounded-control text-text-secondary hover:bg-surface/60 hover:text-text"
            >
              <Icon source={{ lucide: X }} />
            </button>
          </div>
          <ProjectSwitcher project={project} onChange={onProjectChange} inline />
          <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col justify-between gap-4">
            <NavList project={project} group="primary" onNavigate={close} />
            <NavList project={project} group="secondary" onNavigate={close} />
          </nav>
        </div>
      </dialog>
    </>
  );
}

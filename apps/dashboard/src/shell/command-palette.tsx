// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Icon } from './icon';
import { hrefFor, NAV_ITEMS } from './nav';
import { withProject, type ProjectId } from './projects';

interface CommandPaletteProps {
  project: ProjectId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** True for Cmd+K on a Mac and Ctrl+K everywhere else. */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey;
}

/**
 * Finds a page by name or by what it does. It searches pages and nothing
 * else today, and says so, so nobody types a recipient's name expecting a
 * result. Payouts, recipients and receipts join it with the search endpoint.
 */
export function CommandPalette({ project, open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-teal-ink/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-overlay border border-rule bg-surface text-text shadow-overlay"
        >
          <Dialog.Title className="sr-only">Find a page</Dialog.Title>
          <Command label="Find a page" loop>
            <div className="flex items-center gap-3 border-b border-rule px-4 has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-focus">
              <Icon source={{ lucide: Search }} size={18} className="text-text-secondary" />
              <Command.Input
                placeholder="Search pages"
                className="h-12 flex-1 bg-transparent text-body text-text placeholder:text-text-subtle focus-visible:shadow-none focus-visible:outline-none"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-body-s text-text-secondary">
                No page matches that. Try another word.
              </Command.Empty>
              <Command.Group
                heading="Pages"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-body-s [&_[cmdk-group-heading]]:text-text-secondary"
              >
                {NAV_ITEMS.map((item) => (
                  <Command.Item
                    key={item.segment}
                    // Typing matches the name or what the page does, so
                    // "money" finds Funding.
                    value={`${item.label} ${item.summary}`}
                    onSelect={() => {
                      onOpenChange(false);
                      router.push(withProject(hrefFor(item), { project }));
                    }}
                    className="flex cursor-default items-start gap-3 rounded-control px-3 py-2 select-none data-[selected=true]:bg-bg"
                  >
                    <Icon
                      source={item.icon}
                      size={18}
                      className="mt-0.5 shrink-0 text-text-secondary"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-body-s font-medium text-text">{item.label}</span>
                      {/* Every choice says what it is, never a bare name. */}
                      <span className="text-body-s text-text-secondary">{item.summary}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

import { Icon, type IconSource } from './icon';
import { setTheme, useTheme, type Theme } from './preferences';

interface ThemeOption {
  value: Theme;
  label: string;
  icon: IconSource;
}

const SYSTEM: ThemeOption = { value: 'system', label: 'System', icon: { lucide: Monitor } };

const OPTIONS: readonly ThemeOption[] = [
  SYSTEM,
  { value: 'light', label: 'Light', icon: { lucide: Sun } },
  { value: 'dark', label: 'Dark', icon: { lucide: Moon } },
];

function isTheme(value: string): value is Theme {
  return OPTIONS.some((option) => option.value === value);
}

/**
 * A menu rather than three bare icons: the chosen mode is named in words on
 * the trigger, and each option says what it is. Menu items are real focusable
 * controls, so the shared focus ring applies to them unchanged.
 */
export function ThemeSwitch() {
  const theme = useTheme();
  const chosen = OPTIONS.find((option) => option.value === theme) ?? SYSTEM;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Theme: ${chosen.label}. Choose a theme`}
        className="flex h-10 items-center gap-2 rounded-control border border-rule bg-surface px-3 text-body-s text-text transition-[background-color,color] duration-150 ease-out hover:bg-bg"
      >
        <Icon source={chosen.icon} size={20} className="shrink-0 text-text-secondary" />
        {/*
         * The word is dropped on a phone, where showing it squeezes the
         * search control to "Find a pa...". The accessible name on the
         * trigger still carries the current mode.
         */}
        <span className="hidden sm:inline">{chosen.label}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 min-w-48 rounded-overlay border border-rule bg-surface p-2 text-text shadow-overlay"
        >
          <Menu.Label className="px-3 pt-2 pb-2 text-label font-mono text-text-secondary uppercase">
            Theme
          </Menu.Label>
          <Menu.RadioGroup
            value={theme}
            onValueChange={(value) => {
              if (isTheme(value)) setTheme(value);
            }}
          >
            {OPTIONS.map((option) => (
              <Menu.RadioItem
                key={option.value}
                value={option.value}
                // The highlighted row is the one Enter acts on, so it wears
                // the shared ring. The chosen row carries the outline that
                // marks a current choice, plus the mark, so neither state
                // rests on a fill that is nearly its own ground.
                className="group flex h-10 cursor-default items-center gap-3 rounded-control px-3 outline-none select-none data-highlighted:bg-bg data-highlighted:focus-ring-inset data-[state=checked]:bg-bg data-[state=checked]:chosen-ring"
              >
                <Icon
                  source={option.icon}
                  size={20}
                  className="shrink-0 text-text-secondary group-data-[state=checked]:text-text"
                />
                <span className="flex-1 text-body-s text-text-secondary group-data-[state=checked]:text-text">
                  {option.label}
                </span>
                <Menu.ItemIndicator className="shrink-0 text-text">
                  <Icon source={{ lucide: Check }} size={16} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

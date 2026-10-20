// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { Monitor, Moon, Sun } from 'lucide-react';

import { Icon, type IconSource } from './icon';
import { setTheme, useTheme, type Theme } from './preferences';

const OPTIONS: readonly { value: Theme; label: string; icon: IconSource }[] = [
  { value: 'system', label: 'Match system', icon: { lucide: Monitor } },
  { value: 'light', label: 'Light', icon: { lucide: Sun } },
  { value: 'dark', label: 'Dark', icon: { lucide: Moon } },
];

/** Native radios, so arrow keys move between the three options for free. */
export function ThemeSwitch() {
  const theme = useTheme();
  return (
    <fieldset className="flex items-center rounded-control border border-rule bg-surface p-0.5">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          title={option.label}
          className="grid size-9 cursor-pointer place-items-center rounded-control text-text-secondary transition-colors duration-150 ease-out hover:text-text has-checked:bg-bg has-checked:text-text has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus"
        >
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme === option.value}
            onChange={() => {
              setTheme(option.value);
            }}
            className="sr-only"
          />
          <Icon source={option.icon} size={18} />
          <span className="sr-only">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

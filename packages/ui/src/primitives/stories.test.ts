// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { THEMES } from '../../.storybook/modes.ts';
import preview from '../../.storybook/preview.tsx';
import * as alertDialog from '../../stories/alert-dialog.stories.tsx';
import * as button from '../../stories/button.stories.tsx';
import * as checkbox from '../../stories/checkbox.stories.tsx';
import * as command from '../../stories/command.stories.tsx';
import * as dialog from '../../stories/dialog.stories.tsx';
import * as dropdownMenu from '../../stories/dropdown-menu.stories.tsx';
import * as field from '../../stories/field.stories.tsx';
import * as input from '../../stories/input.stories.tsx';
import * as label from '../../stories/label.stories.tsx';
import * as radioGroup from '../../stories/radio-group.stories.tsx';
import * as select from '../../stories/select.stories.tsx';
import * as separator from '../../stories/separator.stories.tsx';
import * as sheet from '../../stories/sheet.stories.tsx';
import * as skeleton from '../../stories/skeleton.stories.tsx';
import * as switchStories from '../../stories/switch.stories.tsx';
import * as textarea from '../../stories/textarea.stories.tsx';
import * as tooltip from '../../stories/tooltip.stories.tsx';

afterEach(cleanup);

// The command list measures itself with ResizeObserver and scrolls its
// selected item into view, and jsdom has neither. Nothing here depends on a
// size or a scroll position, so stand-ins that do nothing are enough.
class StillObserver {
  observe(): void {
    // jsdom lays nothing out, so there is nothing to report.
  }
  unobserve(): void {
    // Nothing was observed.
  }
  disconnect(): void {
    // Nothing was observed.
  }
}

beforeAll(() => {
  if (!Reflect.has(globalThis, 'ResizeObserver')) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: StillObserver,
      configurable: true,
    });
  }
  if (!Reflect.has(Element.prototype, 'scrollIntoView')) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => undefined,
      configurable: true,
    });
  }
});

type StoryModule = Record<string, unknown> & { default: Record<string, unknown> };

// Hover, focus and disabled apply to every control. Invalid applies to the
// controls a form can reject; loading only to the button.
const CONTROL = ['Default', 'Hover', 'Focus', 'Disabled', 'Invalid'];

const CATALOGUE: Record<string, { module: StoryModule; required: string[] }> = {
  'alert-dialog': {
    module: alertDialog,
    required: ['Default', 'Open', 'OpenTypedConfirmation', 'OpenPending'],
  },
  button: { module: button, required: ['Default', 'Hover', 'Focus', 'Disabled', 'Loading'] },
  checkbox: { module: checkbox, required: CONTROL },
  command: { module: command, required: ['Default', 'NoResults'] },
  dialog: { module: dialog, required: ['Default', 'Open', 'OpenPending'] },
  'dropdown-menu': { module: dropdownMenu, required: ['Default', 'Open'] },
  field: { module: field, required: ['Default', 'Focus', 'Disabled', 'Invalid'] },
  input: { module: input, required: CONTROL },
  label: { module: label, required: ['Default', 'Disabled'] },
  'radio-group': { module: radioGroup, required: CONTROL },
  select: { module: select, required: [...CONTROL, 'Open'] },
  separator: { module: separator, required: ['Default'] },
  sheet: { module: sheet, required: ['Default', 'Open'] },
  skeleton: { module: skeleton, required: ['Default'] },
  switch: { module: switchStories, required: CONTROL },
  textarea: { module: textarea, required: CONTROL },
  tooltip: { module: tooltip, required: ['Default', 'Focus', 'Open'] },
};

// Every component file in this folder, not the shared helpers.
const HELPERS = new Set(['control-styles.ts', 'focus-ring.ts', 'index.ts']);
const primitives = readdirSync(import.meta.dirname)
  .filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.') && !HELPERS.has(file))
  .map((file) => file.replace(/\.tsx?$/, ''))
  .sort();

const storyFiles = readdirSync(join(import.meta.dirname, '..', '..', 'stories'))
  .filter((file) => file.endsWith('.stories.tsx'))
  .map((file) => file.replace('.stories.tsx', ''))
  .sort();

function storyNames(module: StoryModule): string[] {
  return Object.keys(module).filter((key) => key !== 'default' && key !== '__namedExportsOrder');
}

describe('stories', () => {
  it('has a story file for every primitive and nothing else', () => {
    expect(primitives.length).toBeGreaterThan(0);
    expect(storyFiles).toEqual(primitives);
    expect(Object.keys(CATALOGUE).sort()).toEqual(primitives);
  });

  it('every primitive exports default, focus, disabled and invalid (where applicable) stories in light and dark', () => {
    // Both modes are offered by the toolbar and run by the browser tests.
    expect(THEMES).toEqual(['light', 'dark']);
    expect(preview.decorators).toBeDefined();
    for (const [name, { module, required }] of Object.entries(CATALOGUE)) {
      const names = storyNames(module);
      for (const story of required) expect(names, name).toContain(story);
      // No story may pin itself to one mode.
      const annotations = [
        module.default,
        ...names.map((story) => module[story] as Record<string, unknown>),
      ];
      for (const annotation of annotations) {
        const globals = annotation['globals'] as Record<string, unknown> | undefined;
        const parameters = annotation['parameters'] as Record<string, unknown> | undefined;
        expect(globals?.['theme'], name).toBeUndefined();
        expect(parameters?.['themes'], name).toBeUndefined();
      }
    }
  });

  it('files every story under Primitives', () => {
    for (const [name, { module }] of Object.entries(CATALOGUE)) {
      expect(String(module.default['title']), name).toMatch(/^Primitives\//);
    }
  });

  // Rendering every story here keeps the stories honest between browser runs.
  // Open overlays are left to the browser tests: jsdom has no layout to
  // position them in.
  for (const [name, { module }] of Object.entries(CATALOGUE)) {
    const composed = composeStories(module as Parameters<typeof composeStories>[0]);
    for (const [story, Story] of Object.entries(composed)) {
      if (story === 'Open') continue;
      it(`${name} ${story} renders`, () => {
        const { container } = render(createElement(Story as () => React.ReactNode));
        expect(container.firstElementChild).not.toBeNull();
      });
    }
  }
});

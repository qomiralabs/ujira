// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { THEMES } from '../../.storybook/modes.ts';
import preview from '../../.storybook/preview.tsx';
import * as alertDialog from '../../stories/alert-dialog.stories.tsx';
import * as button from '../../stories/button.stories.tsx';
import * as checkbox from '../../stories/checkbox.stories.tsx';
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

type StoryModule = Record<string, unknown> & { default: Record<string, unknown> };

// Hover, focus and disabled apply to every control. Invalid applies to the
// controls a form can reject; loading only to the button.
const CONTROL = ['Default', 'Hover', 'Focus', 'Disabled', 'Invalid'];

// An overlay that can carry a money action has a Pending story: the state
// where it must refuse to close.
const OVERLAY = ['Default', 'Focus', 'Pending'];

const CATALOGUE: Record<string, { module: StoryModule; required: string[] }> = {
  'alert-dialog': { module: alertDialog, required: OVERLAY },
  button: { module: button, required: ['Default', 'Hover', 'Focus', 'Disabled', 'Loading'] },
  checkbox: { module: checkbox, required: CONTROL },
  dialog: { module: dialog, required: OVERLAY },
  'dropdown-menu': { module: dropdownMenu, required: ['Default', 'Focus'] },
  field: { module: field, required: ['Default', 'Focus', 'Disabled', 'Invalid'] },
  input: { module: input, required: CONTROL },
  label: { module: label, required: ['Default', 'Disabled'] },
  'radio-group': { module: radioGroup, required: CONTROL },
  select: { module: select, required: [...CONTROL, 'Open'] },
  separator: { module: separator, required: ['Default'] },
  sheet: { module: sheet, required: OVERLAY },
  skeleton: { module: skeleton, required: ['Default'] },
  switch: { module: switchStories, required: CONTROL },
  textarea: { module: textarea, required: CONTROL },
  tooltip: { module: tooltip, required: ['Default', 'Focus', 'Open'] },
};

// Every component file in this folder, not the shared helpers.
const HELPERS = new Set([
  'control-styles.ts',
  'focus-ring.ts',
  'index.ts',
  'overlay-styles.ts',
  'use-pending-lock.ts',
]);
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
  for (const [name, { module }] of Object.entries(CATALOGUE)) {
    const composed = composeStories(module as Parameters<typeof composeStories>[0]);
    for (const [story, Story] of Object.entries(composed)) {
      // The select's open list and the tooltip's open bubble are positioned
      // by Radix, which needs layout jsdom does not have. The browser tests
      // cover both.
      if (story === 'Open' && (name === 'select' || name === 'tooltip')) continue;
      it(`${name} ${story} renders`, () => {
        // Checked on the whole document, not the container: an overlay
        // renders into a portal on document.body. A data-slot proves a
        // primitive rendered rather than only the story's own wrapper.
        const { baseElement } = render(createElement(Story as () => React.ReactNode));
        expect(baseElement.querySelector('[data-slot]')).not.toBeNull();
      });
    }
  }
});

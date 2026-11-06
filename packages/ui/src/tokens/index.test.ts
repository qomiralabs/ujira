// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as ui from '../index.js';
import { cssVar, type ColorMode, type ModeToken } from './index.js';

describe('token exports', () => {
  it('names the CSS custom property of a token', () => {
    expect(cssVar('surface')).toBe('var(--ujira-surface)');
    expect(cssVar('viz-categorical-1')).toBe('var(--ujira-viz-categorical-1)');
  });

  it('types the colour modes and their shared token names', () => {
    expectTypeOf<ColorMode>().toEqualTypeOf<'light' | 'dark'>();
    expectTypeOf<ModeToken>().toEqualTypeOf<keyof typeof ui.modes.dark>();
  });

  it('exposes the tokens, icons and primitives from the package entry', () => {
    expect(Object.keys(ui).sort()).toEqual([
      'AlertDialog',
      'Amount',
      'AmountProvider',
      'BADGE_STATUSES',
      'BrandIcon',
      'Button',
      'Checkbox',
      'ColumnChooser',
      'Command',
      'CommandEmpty',
      'CommandGroup',
      'CommandInput',
      'CommandItem',
      'CommandList',
      'DataTable',
      'DensityToggle',
      'DetailSheet',
      'Dialog',
      'DialogClose',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogTitle',
      'DialogTrigger',
      'DropdownMenu',
      'DropdownMenuContent',
      'DropdownMenuGroup',
      'DropdownMenuItem',
      'DropdownMenuLabel',
      'DropdownMenuSeparator',
      'DropdownMenuTrigger',
      'EmptyState',
      'FOCUS_RING',
      'Field',
      'Input',
      'KpiCard',
      'Label',
      'MandateMeter',
      'PayoutCard',
      'RadioGroup',
      'RadioGroupItem',
      'STATUS_SPECS',
      'Select',
      'SelectContent',
      'SelectGroup',
      'SelectItem',
      'SelectLabel',
      'SelectSeparator',
      'SelectTrigger',
      'SelectValue',
      'Separator',
      'Sheet',
      'SheetClose',
      'SheetContent',
      'SheetDescription',
      'SheetTitle',
      'SheetTrigger',
      'Skeleton',
      'StatusBadge',
      'Switch',
      'Textarea',
      'TokenAmount',
      'Tooltip',
      'TooltipContent',
      'TooltipProvider',
      'TooltipTrigger',
      'VIRTUALIZE_ABOVE',
      'brandIconNames',
      'buttonVariants',
      'cn',
      'compareMoney',
      'cssVar',
      'deltaText',
      'density',
      'focus',
      'fonts',
      'formatMoney',
      'localeDirection',
      'meterSegments',
      'modes',
      'motion',
      'palette',
      'percentOf',
      'radius',
      'shadow',
      'status',
      'typeScale',
      'useAmountSettings',
      'useFieldControl',
      'viz',
    ]);
  });
});

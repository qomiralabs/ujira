// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Amount } from '../../src/money/amount.js';
import {
  ColumnChooser,
  type ColumnVisibility,
} from '../../src/patterns/data-table/column-chooser.js';
import {
  DataTable,
  type DataColumn,
  type DataTableProps,
} from '../../src/patterns/data-table/data-table.js';
import { DensityToggle, type Density } from '../../src/patterns/data-table/density-toggle.js';
import { compareMoney } from '../../src/patterns/data-table/sorting.js';
import { PayoutCard } from '../../src/payments/payout-card.js';
import { STATUS_SPECS, StatusBadge } from '../../src/payments/status-badge.js';
import type { RowSelectionState, SortingState } from '@tanstack/react-table';
import { samplePayouts, type SamplePayout } from './sample-payouts.js';

const COLUMNS: DataColumn<SamplePayout>[] = [
  {
    id: 'recipient',
    header: 'Recipient',
    hideable: false,
    cell: (row) => <span className="font-medium">{row.recipient}</span>,
    compare: (a, b) => a.recipient.localeCompare(b.recipient),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'end',
    width: '11rem',
    cell: (row) => <Amount value={row.amount} size="data" />,
    compare: (a, b) => compareMoney(a.usd, b.usd),
  },
  {
    id: 'status',
    header: 'Status',
    width: '13rem',
    cell: (row) => <StatusBadge status={row.status} />,
    compare: (a, b) => STATUS_SPECS[a.status].word.localeCompare(STATUS_SPECS[b.status].word),
  },
  {
    id: 'corridor',
    header: 'Corridor',
    width: '9rem',
    cell: (row) => row.corridor,
    compare: (a, b) => a.corridor.localeCompare(b.corridor),
  },
  {
    id: 'created',
    header: 'Created',
    // The full date and time in the mono face: 18 characters and the padding.
    width: '12rem',
    cell: (row) => <span className="font-mono text-data tabular-nums">{row.created}</span>,
  },
];

type Props = Partial<DataTableProps<SamplePayout>> & { rows?: number };

/** A table wired the way a screen wires it: the state outside, the toolbar beside it. */
function PayoutsTable({ rows = 24, ...props }: Props) {
  const [data] = useState(() => samplePayouts(rows));
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<ColumnVisibility>({});
  const [density, setDensity] = useState<Density>(props.density ?? 'comfortable');
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [opened, setOpened] = useState<SamplePayout | undefined>();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-4">
        <DensityToggle density={density} onDensityChange={setDensity} />
        <ColumnChooser
          columns={COLUMNS}
          visibility={visibility}
          onVisibilityChange={setVisibility}
        />
      </div>
      <DataTable
        caption="Payouts"
        data={data}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        rowLabel={(row) => row.recipient}
        sorting={sorting}
        onSortingChange={setSorting}
        columnVisibility={visibility}
        onColumnVisibilityChange={setVisibility}
        density={density}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        onRowOpen={setOpened}
        {...(opened === undefined ? {} : { activeRowId: opened.id })}
        renderCard={(row) => (
          <PayoutCard
            recipient={row.recipient}
            amount={row.amount}
            status={row.status}
            method="USDC to Stellar wallet"
            corridor={row.corridor}
            timing={{ label: 'Created', value: row.created }}
          />
        )}
        {...props}
      />
      <p data-testid="opened" className="text-body-s text-text-secondary" aria-live="polite">
        {opened === undefined ? 'No payout open.' : `Opened ${opened.recipient}, ${opened.id}.`}
      </p>
    </div>
  );
}

const meta = {
  title: 'Patterns/DataTable',
  component: PayoutsTable,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PayoutsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Compact: Story = { args: { density: 'compact' } };

/** Checkboxes for safe bulk actions. Clicking a checkbox never opens the row. */
export const Selection: Story = { args: { selectable: true } };

/** Skeleton rows in the final layout, so nothing moves when the data arrives. */
export const Loading: Story = { args: { loading: true } };

export const Empty: Story = {
  args: {
    data: [],
    empty: (
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="font-medium text-text">No payouts yet</p>
        <p className="text-text-secondary">
          Fund a mandate and request a payout. It shows here the moment it is created.
        </p>
      </div>
    ),
  },
};

export const NoResults: Story = {
  args: {
    data: [],
    filtered: true,
    noResults: (
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="font-medium text-text">No payouts match these filters</p>
        <p className="text-text-secondary">Clear a filter or widen the dates to see more.</p>
      </div>
    ),
  },
};

/** Ten thousand rows: only the rows in view are in the page. */
export const TenThousandRows: Story = { args: { rows: 10_000 } };

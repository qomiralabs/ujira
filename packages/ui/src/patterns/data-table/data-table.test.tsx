// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { money } from '@ujira/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Amount } from '../../money/amount.js';
import { formatMoney } from '../../money/format.js';
import { ColumnChooser } from './column-chooser.js';
import { DataTable, VIRTUALIZE_ABOVE, type DataColumn } from './data-table.js';
import { DensityToggle } from './density-toggle.js';
import { compareMoney } from './sorting.js';

afterEach(cleanup);

interface Payout {
  id: string;
  recipient: string;
  amount: ReturnType<typeof money>;
}

function payouts(count: number): Payout[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `po_${String(index).padStart(5, '0')}`,
    recipient: `Recipient ${String(index)}`,
    amount: money(String((index * 7919) % 100_000), 'USD'),
  }));
}

const COLUMNS: DataColumn<Payout>[] = [
  {
    id: 'recipient',
    header: 'Recipient',
    cell: (row) => row.recipient,
    compare: (a, b) => a.recipient.localeCompare(b.recipient),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'end',
    cell: (row) => <Amount value={row.amount} size="data" />,
    compare: (a, b) => compareMoney(a.amount, b.amount),
  },
  { id: 'id', header: 'Payout ID', cell: (row) => row.id },
];

function table(props: Partial<Parameters<typeof DataTable<Payout>>[0]> = {}) {
  return (
    <DataTable
      caption="Payouts"
      data={payouts(5)}
      columns={COLUMNS}
      getRowId={(row) => row.id}
      rowLabel={(row) => row.recipient}
      {...props}
    />
  );
}

function bodyRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('tbody tr[data-index]')];
}

// The first render loads TanStack and the primitives, which is slow on a
// loaded runner.
describe('DataTable', { timeout: 30_000 }, () => {
  it('keeps a minimum width, so a narrow frame scrolls instead of crushing a column', () => {
    const { rerender } = render(table());
    expect(screen.getByRole('table').style.minWidth).toBe('56rem');
    rerender(table({ minWidth: '40rem' }));
    expect(screen.getByRole('table').style.minWidth).toBe('40rem');
  });

  it('renders a captioned table with a header per visible column', () => {
    render(table());
    const grid = screen.getByRole('table', { name: 'Payouts' });
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual(['Recipient', 'Amount', 'Payout ID']);
    expect(bodyRows()).toHaveLength(5);
  });

  it('right aligns amount columns and sets their cells in tabular figures', () => {
    render(table());
    const header = screen.getByRole('columnheader', { name: /Amount/ });
    expect(header.className).toContain('text-end');
    const cell = bodyRows()[1]?.querySelectorAll('td')[1];
    expect(cell?.className).toContain('text-end');
    expect(cell?.querySelector('[data-slot="amount-value"]')?.className).toContain('tabular-nums');
  });

  it(`renders every row up to ${String(VIRTUALIZE_ABOVE)}`, () => {
    render(table({ data: payouts(VIRTUALIZE_ABOVE) }));
    expect(bodyRows()).toHaveLength(VIRTUALIZE_ABOVE);
  });

  it('101 rows render fewer DOM rows than data rows', () => {
    // jsdom lays nothing out, so the scrolling frame is given the size a
    // browser would measure: 640px tall, room for about fourteen rows.
    const stubs = [
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(640),
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1024),
    ];
    render(table({ data: payouts(VIRTUALIZE_ABOVE + 1) }));
    for (const stub of stubs) stub.mockRestore();
    const rendered = bodyRows().length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(VIRTUALIZE_ABOVE + 1);
    // The table still says how many rows there are in all.
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe(
      String(VIRTUALIZE_ABOVE + 2),
    );
  });

  it('sort, columns and density are read from and reported to props', () => {
    const onSortingChange = vi.fn();
    const onColumnVisibilityChange = vi.fn();
    const onDensityChange = vi.fn();
    const data = payouts(5);
    render(
      <>
        <DataTable
          caption="Payouts"
          data={data}
          columns={COLUMNS}
          getRowId={(row) => row.id}
          rowLabel={(row) => row.recipient}
          sorting={[{ id: 'amount', desc: true }]}
          onSortingChange={onSortingChange}
          columnVisibility={{ id: false }}
          onColumnVisibilityChange={onColumnVisibilityChange}
          density="compact"
        />
        <ColumnChooser
          columns={COLUMNS}
          visibility={{ id: false }}
          onVisibilityChange={onColumnVisibilityChange}
        />
        <DensityToggle density="compact" onDensityChange={onDensityChange} />
      </>,
    );
    // Read: sorted by amount, largest first; the hidden column is gone; rows are compact.
    const grid = screen.getByRole('table');
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Recipient', 'Amount']);
    const amountHeader = screen.getByRole('columnheader', { name: /Amount/ });
    expect(amountHeader.getAttribute('aria-sort')).toBe('descending');
    const shown = bodyRows().map((row) => row.getAttribute('data-row-id'));
    const expected = [...data]
      .sort((a, b) => compareMoney(b.amount, a.amount))
      .map((row) => row.id);
    expect(shown).toEqual(expected);
    expect(grid.closest('[data-density]')?.getAttribute('data-density')).toBe('compact');

    // Reported: a header click asks for the next sort, the chooser and the
    // toggle report their change, and nothing changes until the props do.
    fireEvent.click(within(amountHeader).getByRole('button'));
    expect(onSortingChange).toHaveBeenCalledWith([]);
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Recipient/ }));
    expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'recipient', desc: false }]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payout ID' }));
    expect(onColumnVisibilityChange).toHaveBeenCalledWith({ id: true });
    fireEvent.click(screen.getByRole('switch', { name: 'Compact rows' }));
    expect(onDensityChange).toHaveBeenCalledWith('comfortable');
    expect(amountHeader.getAttribute('aria-sort')).toBe('descending');
  });

  it('sorts on its own when no sort is passed', () => {
    render(table());
    fireEvent.click(screen.getByRole('button', { name: /Amount/ }));
    const amounts = bodyRows().map((row) => row.querySelectorAll('td')[1]?.textContent);
    const sorted = payouts(5)
      .map((row) => row.amount)
      .sort(compareMoney)
      .map((value) => formatMoney(value.amount, value.currency, 'en'));
    expect(amounts).toEqual(sorted);
  });

  it('opens a row on click and on Enter, and moves with the arrow keys, Home and End', () => {
    const onRowOpen = vi.fn();
    render(table({ onRowOpen }));
    const rows = bodyRows();
    const [first, , third] = rows;
    if (first === undefined || third === undefined) throw new Error('five rows expected');
    fireEvent.click(third);
    expect(onRowOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'po_00002' }));

    // One row is in the tab order at a time.
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('po_00001');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('po_00004');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('po_00003');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('po_00000');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onRowOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'po_00000' }));
    expect(bodyRows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it('marks the open row', () => {
    render(table({ activeRowId: 'po_00003' }));
    const active = bodyRows().find((row) => row.getAttribute('data-row-id') === 'po_00003');
    expect(active?.getAttribute('aria-current')).toBe('true');
  });

  it('selects rows for bulk actions without opening them, and reports the selection', () => {
    const onRowOpen = vi.fn();
    const onRowSelectionChange = vi.fn();
    render(table({ onRowOpen, rowSelection: {}, onRowSelectionChange, selectable: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Recipient 1' }));
    expect(onRowSelectionChange).toHaveBeenCalledWith({ po_00001: true });
    expect(onRowOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every row' }));
    expect(onRowSelectionChange).toHaveBeenLastCalledWith(
      Object.fromEntries(payouts(5).map((row) => [row.id, true])),
    );
  });

  it('shows the empty slot when there is nothing yet, and the no results slot when filters hide everything', () => {
    const { rerender } = render(table({ data: [], empty: <p>No payouts yet.</p> }));
    expect(screen.getByText('No payouts yet.')).toBeTruthy();
    rerender(
      table({
        data: [],
        filtered: true,
        empty: <p>No payouts yet.</p>,
        noResults: <p>No payouts match these filters.</p>,
      }),
    );
    expect(screen.queryByText('No payouts yet.')).toBeNull();
    expect(screen.getByText('No payouts match these filters.')).toBeTruthy();
    // The slot spans every column, so the header keeps its shape.
    expect(document.querySelector('tbody td')?.getAttribute('colspan')).toBe('3');
  });

  it('shows skeleton rows in the final layout while loading, and says it is busy', () => {
    render(table({ loading: true }));
    const grid = screen.getByRole('table');
    expect(grid.getAttribute('aria-busy')).toBe('true');
    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelectorAll('td')).toHaveLength(3);
      expect(row.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    }
    expect(screen.queryByText('Recipient 1')).toBeNull();
  });

  it('renders rows as stacked cards through the card slot below the tablet width', () => {
    render(table({ renderCard: (row) => <article>{row.recipient} card</article> }));
    const cards = document.querySelector('[data-slot="data-table-cards"]');
    expect(cards?.className).toContain('md:hidden');
    expect(cards?.querySelectorAll('article')).toHaveLength(5);
    const tableFrame = document.querySelector('[data-slot="data-table-frame"]');
    expect(tableFrame?.className).toContain('hidden');
    expect(tableFrame?.className).toContain('md:block');
  });
});

describe('compareMoney', () => {
  it('orders by amount within a currency and keeps currencies together', () => {
    expect(compareMoney(money('100', 'USD'), money('99', 'USD'))).toBe(1);
    expect(compareMoney(money('-1', 'USD'), money('0', 'USD'))).toBe(-1);
    expect(compareMoney(money('5', 'USD'), money('5', 'USD'))).toBe(0);
    expect(compareMoney(money('999999', 'KES'), money('1', 'NGN'))).toBe(-1);
  });
});

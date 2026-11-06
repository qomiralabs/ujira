// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn.js';
import { Checkbox } from '../../primitives/checkbox.js';
import { FOCUS_RING } from '../../primitives/focus-ring.js';
import { Skeleton } from '../../primitives/skeleton.js';
import type { ColumnVisibility } from './column-chooser.js';
import type { Density } from './density-toggle.js';

/** Above this many rows only the rows in view are in the page. */
export const VIRTUALIZE_ABOVE = 100;

const ROW_HEIGHT: Readonly<Record<Density, number>> = { comfortable: 44, compact: 36 };
const SKELETON_ROWS = 8;
const SELECT_COLUMN = '__select';

export interface DataColumn<Row> {
  id: string;
  /** Plain words: the header, the sort button's name and the column chooser's label. */
  header: string;
  cell: (row: Row) => ReactNode;
  /** `end` for amounts and other figures, so they line up on the right. */
  align?: 'start' | 'end';
  /** Makes the column sortable. Return the order of two rows. */
  compare?: (a: Row, b: Row) => number;
  /** False keeps the column out of the chooser, for the one that names the row. */
  hideable?: boolean;
  /** A fixed width, such as '10rem'. Columns without one share what is left. */
  width?: string;
}

export interface DataTableProps<Row> {
  /** Names the table for assistive technology. */
  caption: string;
  data: readonly Row[];
  columns: readonly DataColumn<Row>[];
  getRowId: (row: Row) => string;
  /** Names a row in words, for its selection checkbox. */
  rowLabel: (row: Row) => string;
  /** Controlled sort. Leave out to let the table sort on its own. */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  columnVisibility?: ColumnVisibility;
  onColumnVisibilityChange?: (visibility: ColumnVisibility) => void;
  density?: Density;
  /** Adds a checkbox column for bulk actions. */
  selectable?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  /** Called on a row click and on Enter, usually to open its detail sheet. */
  onRowOpen?: (row: Row) => void;
  /** The row whose detail is open. */
  activeRowId?: string;
  loading?: boolean;
  /** True when filters are applied, so an empty result shows `noResults` rather than `empty`. */
  filtered?: boolean;
  /** Shown when there is nothing at all yet. Say what to do next. */
  empty?: ReactNode;
  /** Shown when the filters hide every row. Say how to widen them. */
  noResults?: ReactNode;
  /** A row as a stacked card. When given, phones see cards instead of the table. */
  renderCard?: (row: Row) => ReactNode;
  className?: string;
}

function resolve<T>(updater: Updater<T>, current: T): T {
  return typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;
}

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);

/**
 * The shared table: sticky header, sorting, column visibility, density,
 * selection, keyboard row navigation and a detail on click or Enter. Above a
 * hundred rows only the rows in view are rendered. Sort, columns, density and
 * selection can each be owned by the caller, so a screen can keep them in the
 * URL. Below the tablet width, `renderCard` turns rows into stacked cards.
 */
export function DataTable<Row>({
  caption,
  data,
  columns,
  getRowId,
  rowLabel,
  sorting: sortingProp,
  onSortingChange,
  columnVisibility = {},
  onColumnVisibilityChange,
  density = 'comfortable',
  selectable = false,
  rowSelection: rowSelectionProp,
  onRowSelectionChange,
  onRowOpen,
  activeRowId,
  loading = false,
  filtered = false,
  empty,
  noResults,
  renderCard,
  className,
}: DataTableProps<Row>) {
  const [ownSorting, setOwnSorting] = useState<SortingState>([]);
  const [ownSelection, setOwnSelection] = useState<RowSelectionState>({});
  const sorting = sortingProp ?? ownSorting;
  const rowSelection = rowSelectionProp ?? ownSelection;

  const definitions = useMemo<ColumnDef<Row>[]>(() => {
    const own: ColumnDef<Row>[] = columns.map((column) => ({
      id: column.id,
      header: column.header,
      accessorFn: (row) => row,
      cell: (context) => column.cell(context.row.original),
      enableSorting: column.compare !== undefined,
      // Every column sorts ascending first, then descending, then not at all.
      sortDescFirst: false,
      enableHiding: column.hideable !== false,
      sortingFn: (a, b) => column.compare?.(a.original, b.original) ?? 0,
    }));
    if (!selectable) return own;
    return [{ id: SELECT_COLUMN, enableSorting: false, enableHiding: false }, ...own];
  }, [columns, selectable]);

  const table = useReactTable<Row>({
    // TanStack reads the array and never writes to it.
    data: data as Row[],
    columns: definitions,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: selectable,
    enableSortingRemoval: true,
    state: { sorting, columnVisibility: { ...columnVisibility }, rowSelection },
    onSortingChange: (updater) => {
      const next = resolve(updater, sorting);
      if (sortingProp === undefined) setOwnSorting(next);
      onSortingChange?.(next);
    },
    onColumnVisibilityChange: (updater) => {
      onColumnVisibilityChange?.(resolve(updater, { ...columnVisibility }));
    },
    onRowSelectionChange: (updater) => {
      const next = resolve(updater, rowSelection);
      if (rowSelectionProp === undefined) setOwnSelection(next);
      onRowSelectionChange?.(next);
    },
  });

  const rows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();
  const meta = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const virtualize = rows.length > VIRTUALIZE_ABOVE;
  const rowHeight = ROW_HEIGHT[density];

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtualize,
    // Rows to draw before the frame has been measured, and on the server.
    initialRect: { width: 1024, height: 640 },
  });

  const virtualItems = virtualize ? virtualizer.getVirtualItems() : [];
  const shown = virtualize
    ? virtualItems.map((item) => ({ index: item.index, row: rows[item.index] }))
    : rows.map((row, index) => ({ index, row }));
  const paddingTop = virtualize ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom = virtualize
    ? virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0)
    : 0;

  // Keyboard navigation: one row is in the tab order, the arrows move it.
  const [activeIndex, setActiveIndex] = useState(0);
  const pendingFocus = useRef(false);
  const lastIndex = rows.length - 1;
  const current = Math.min(activeIndex, Math.max(lastIndex, 0));
  const tabbable = shown.some((item) => item.index === current) ? current : shown[0]?.index;

  const moveTo = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(index, lastIndex));
      pendingFocus.current = true;
      setActiveIndex(next);
      if (virtualize) virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [lastIndex, virtualize, virtualizer],
  );

  useEffect(() => {
    if (!pendingFocus.current) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `tbody tr[data-index="${String(current)}"]`,
    );
    if (element !== null && element !== undefined) {
      pendingFocus.current = false;
      element.focus({ preventScroll: virtualize });
    }
  });

  const pageSize = Math.max(1, Math.floor(640 / rowHeight) - 1);

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, index: number) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      const row = rows[index];
      if (row !== undefined) onRowOpen?.(row.original);
      event.preventDefault();
      return;
    }
    if (!NAVIGATION_KEYS.has(event.key)) return;
    event.preventDefault();
    const target = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: lastIndex,
      PageDown: index + pageSize,
      PageUp: index - pageSize,
    }[event.key];
    if (target !== undefined) moveTo(target);
  }

  const columnCount = leafColumns.length;
  const allSelected = table.getIsAllRowsSelected();
  const someSelected = table.getIsSomeRowsSelected();

  function header(columnId: string) {
    if (columnId === SELECT_COLUMN) {
      return (
        <Checkbox
          aria-label="Select every row"
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={(checked) => {
            table.toggleAllRowsSelected(checked === true);
          }}
        />
      );
    }
    const column = table.getColumn(columnId);
    const spec = meta.get(columnId);
    if (column === undefined || spec === undefined) return null;
    if (!column.getCanSort()) return spec.header;
    const direction = column.getIsSorted();
    const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
    return (
      <button
        type="button"
        onClick={column.getToggleSortingHandler()}
        className={cn(
          'inline-flex items-center gap-1 rounded-control hover:text-text',
          spec.align === 'end' && 'flex-row-reverse',
          FOCUS_RING,
        )}
      >
        {spec.header}
        <Icon
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn('size-3.5', direction === false && 'opacity-50')}
        />
      </button>
    );
  }

  const ariaSort = (columnId: string) => {
    const direction = table.getColumn(columnId)?.getIsSorted();
    if (direction === 'asc') return 'ascending' as const;
    if (direction === 'desc') return 'descending' as const;
    return undefined;
  };

  const nothing = !loading && rows.length === 0;
  const slot = filtered ? noResults : empty;

  const frame = (
    <div
      ref={scrollRef}
      data-slot="data-table-frame"
      data-density={density}
      className={cn(
        'max-h-[min(70vh,44rem)] overflow-auto rounded-card border border-rule bg-surface',
        renderCard !== undefined && 'hidden md:block',
      )}
    >
      <table
        aria-label={caption}
        aria-rowcount={rows.length + 1}
        aria-busy={loading || undefined}
        className="w-full table-fixed border-separate border-spacing-0 text-body-s text-text"
      >
        <colgroup>
          {leafColumns.map((column) => (
            <col
              key={column.id}
              style={{
                width: column.id === SELECT_COLUMN ? '3rem' : meta.get(column.id)?.width,
              }}
            />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr aria-rowindex={1}>
            {leafColumns.map((column) => {
              const align = meta.get(column.id)?.align ?? 'start';
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort(column.id)}
                  className={cn(
                    'h-row border-b border-rule px-3 font-medium whitespace-nowrap text-text-secondary',
                    align === 'end' ? 'text-end' : 'text-start',
                  )}
                >
                  {header(column.id)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <tr key={index}>
                  {leafColumns.map((column) => (
                    <td key={column.id} className="h-row border-b border-rule px-3">
                      <Skeleton
                        className={cn(
                          'h-3',
                          meta.get(column.id)?.align === 'end' ? 'ms-auto w-20' : 'w-3/4',
                        )}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {nothing ? (
            <tr>
              <td colSpan={columnCount} className="px-3 py-10">
                {slot}
              </td>
            </tr>
          ) : null}
          {!loading && paddingTop > 0 ? (
            <tr aria-hidden="true" style={{ height: paddingTop }}>
              <td colSpan={columnCount} />
            </tr>
          ) : null}
          {loading
            ? null
            : shown.map(({ index, row }) => {
                if (row === undefined) return null;
                const id = row.id;
                const active = id === activeRowId;
                return (
                  <tr
                    key={id}
                    data-index={index}
                    data-row-id={id}
                    aria-rowindex={index + 2}
                    aria-selected={selectable ? row.getIsSelected() : undefined}
                    aria-current={active || undefined}
                    tabIndex={index === tabbable ? 0 : -1}
                    onClick={() => {
                      setActiveIndex(index);
                      onRowOpen?.(row.original);
                    }}
                    onKeyDown={(event) => {
                      onRowKeyDown(event, index);
                    }}
                    onFocus={() => {
                      if (index !== current) setActiveIndex(index);
                    }}
                    className={cn(
                      onRowOpen !== undefined && 'cursor-pointer',
                      'hover:bg-bg focus-visible:bg-bg aria-[current=true]:bg-bg',
                      // The brand ring, drawn inside the row so the scrolling
                      // frame cannot clip it.
                      'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const columnId = cell.column.id;
                      if (columnId === SELECT_COLUMN) {
                        return (
                          <td
                            key={cell.id}
                            className="h-row border-b border-rule px-3"
                            onClick={(event) => {
                              event.stopPropagation();
                            }}
                          >
                            <Checkbox
                              aria-label={`Select ${rowLabel(row.original)}`}
                              checked={row.getIsSelected()}
                              onCheckedChange={(checked) => {
                                row.toggleSelected(checked === true);
                              }}
                            />
                          </td>
                        );
                      }
                      const align = meta.get(columnId)?.align ?? 'start';
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            'h-row truncate border-b border-rule px-3',
                            align === 'end' ? 'text-end' : 'text-start',
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          {!loading && paddingBottom > 0 ? (
            <tr aria-hidden="true" style={{ height: paddingBottom }}>
              <td colSpan={columnCount} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );

  return (
    <div data-slot="data-table" className={cn('flex flex-col gap-3', className)}>
      {frame}
      {renderCard === undefined ? null : (
        <DataTableCards
          rows={rows.map((row) => row.original)}
          getRowId={getRowId}
          renderCard={renderCard}
          loading={loading}
          slot={nothing ? slot : undefined}
        />
      )}
    </div>
  );
}

interface DataTableCardsProps<Row> {
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  renderCard: (row: Row) => ReactNode;
  loading: boolean;
  slot: ReactNode;
}

const CARD_ESTIMATE = 184;

/** The phone form of the table: each row as a card, virtualised like the rows. */
function DataTableCards<Row>({
  rows,
  getRowId,
  renderCard,
  loading,
  slot,
}: DataTableCardsProps<Row>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE,
    overscan: 4,
    enabled: virtualize,
    initialRect: { width: 375, height: 640 },
  });
  const items = virtualize
    ? virtualizer
        .getVirtualItems()
        .map((item) => ({ index: item.index, start: item.start, row: rows[item.index] }))
    : rows.map((row, index) => ({ index, start: 0, row }));

  return (
    <div
      ref={scrollRef}
      data-slot="data-table-cards"
      aria-busy={loading || undefined}
      className={cn('md:hidden', virtualize && 'max-h-[75vh] overflow-auto')}
    >
      {loading ? (
        <ul className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-40 w-full rounded-card" />
            </li>
          ))}
        </ul>
      ) : slot !== undefined ? (
        slot
      ) : (
        <ul
          className="relative flex flex-col gap-3"
          style={virtualize ? { height: virtualizer.getTotalSize() } : undefined}
        >
          {items.map(({ index, start, row }) =>
            row === undefined ? null : (
              <li
                key={getRowId(row)}
                data-index={index}
                ref={virtualize ? virtualizer.measureElement : undefined}
                className={virtualize ? 'absolute inset-x-0 top-0 pb-3' : undefined}
                style={virtualize ? { transform: `translateY(${String(start)}px)` } : undefined}
              >
                {renderCard(row)}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

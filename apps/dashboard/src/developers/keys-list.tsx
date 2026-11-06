// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { Button, cn, DataTable, type DataColumn } from '@ujira/ui';
import { Ban, CalendarClock, CalendarX, KeyRound, RefreshCw, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ApiKeyListItem } from '../data/api-keys';
import { formatDate, formatDayTime, isoOf } from '../patterns/dates';
import { Icon } from '../shell/icon';
import {
  canRevoke,
  canRotate,
  keyLabel,
  keyState,
  scopeLabel,
  scopeSummary,
  type KeyState,
} from './key-status';

export type KeyAction = 'rotate' | 'revoke';

interface KeysListProps {
  keys: readonly ApiKeyListItem[];
  now: Date;
  onAction: (action: KeyAction, key: ApiKeyListItem) => void;
}

interface Row {
  key: ApiKeyListItem;
  state: KeyState;
}

const quiet = (row: Row) => row.state.kind === 'expired' || row.state.kind === 'revoked';

function StatusText({ state }: { state: KeyState }) {
  // Words and an icon, in the text colours: the payment status colours mean
  // a payment was paid, waiting or blocked, and a key is none of those.
  switch (state.kind) {
    case 'active':
      return (
        <span className="inline-flex items-center gap-1.5 text-text">
          <Icon source={{ lucide: KeyRound }} size={16} />
          Active
        </span>
      );
    case 'replaced':
      return (
        <span className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-text">
            <Icon source={{ lucide: RefreshCw }} size={16} />
            Being replaced
          </span>
          <span className="text-text-secondary">
            Stops <time dateTime={isoOf(state.stopsAt)}>{formatDayTime(state.stopsAt)}</time>
          </span>
        </span>
      );
    case 'expired':
      return (
        <span className="inline-flex items-center gap-1.5 text-text-secondary">
          <Icon source={{ lucide: CalendarX }} size={16} />
          Expired
        </span>
      );
    case 'revoked':
      return (
        <span className="inline-flex items-center gap-1.5 text-text-secondary">
          <Icon source={{ lucide: Ban }} size={16} />
          Revoked
        </span>
      );
  }
}

function Expiry({ row }: { row: Row }) {
  const date = <time dateTime={isoOf(row.key.expiresAt)}>{formatDate(row.key.expiresAt)}</time>;
  if (row.state.kind === 'active' && row.state.expiringSoon) {
    const days = row.state.daysLeft;
    return (
      <span className="flex flex-col gap-0.5">
        {date}
        <span className="inline-flex items-center gap-1.5 font-medium text-text">
          <Icon source={{ lucide: CalendarClock }} size={16} />
          {days === 1 ? 'Expires within a day' : `Expires in ${String(days)} days`}
        </span>
      </span>
    );
  }
  return date;
}

function Permissions({ scopes, wrap }: { scopes: readonly string[]; wrap: boolean }) {
  const summary = scopeSummary(scopes);
  const detail = scopes.map(scopeLabel).join(', ');
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-text">{summary.label}</span>
      {summary.preset === null ? (
        // In the table the line is cut to fit and the whole list is its
        // title; on a card it wraps.
        <span
          className={cn('text-text-secondary', wrap ? 'break-words' : 'truncate')}
          title={wrap ? undefined : detail}
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
}

function LastUsed({ value }: { value: string | null }) {
  return value === null ? <>Never</> : <time dateTime={value}>{formatDate(value)}</time>;
}

function Actions({ row, onAction }: { row: Row; onAction: KeysListProps['onAction'] }) {
  const label = keyLabel(row.key);
  const rotate = canRotate(row.state);
  const revoke = canRevoke(row.state);
  if (!rotate && !revoke) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {rotate ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Rotate ${label}`}
          icon={<RotateCw aria-hidden="true" strokeWidth={1.5} />}
          onClick={() => {
            onAction('rotate', row.key);
          }}
        >
          Rotate
        </Button>
      ) : null}
      {revoke ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Revoke ${label}`}
          icon={<Ban aria-hidden="true" strokeWidth={1.5} />}
          onClick={() => {
            onAction('revoke', row.key);
          }}
        >
          Revoke
        </Button>
      ) : null}
    </span>
  );
}

function KeyName({ keyItem, wrap }: { keyItem: ApiKeyListItem; wrap: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cn('font-medium text-text', wrap ? 'break-words' : 'truncate')}>
        {keyItem.name ?? 'Unnamed key'}
      </span>
      <span
        className={cn('font-mono text-data text-text-secondary', wrap ? 'break-all' : 'truncate')}
        translate="no"
      >
        {keyItem.prefix}
      </span>
    </span>
  );
}

function Cell({ row, children }: { row: Row; children: ReactNode }) {
  return <span className={cn('block py-2', quiet(row) && 'text-text-secondary')}>{children}</span>;
}

function Term({ children }: { children: ReactNode }) {
  return <dt className="font-mono text-label text-text-secondary uppercase">{children}</dt>;
}

function KeyCard({ row, onAction }: { row: Row; onAction: KeysListProps['onAction'] }) {
  return (
    <article
      aria-label={keyLabel(row.key)}
      className={cn(
        'flex flex-col gap-4 rounded-card border border-rule bg-surface p-4 text-body-s',
        quiet(row) && 'text-text-secondary',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <KeyName keyItem={row.key} wrap />
        <span className="shrink-0">
          <StatusText state={row.state} />
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Term>Permissions</Term>
          <dd>
            <Permissions scopes={row.key.scopes} wrap />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <Term>Created</Term>
          <dd>
            <time dateTime={row.key.createdAt}>{formatDate(row.key.createdAt)}</time>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <Term>Last used</Term>
          <dd>
            <LastUsed value={row.key.lastUsedAt} />
          </dd>
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <Term>Expires</Term>
          <dd>
            <Expiry row={row} />
          </dd>
        </div>
      </dl>
      <Actions row={row} onAction={onAction} />
    </article>
  );
}

function columnsFor(onAction: KeysListProps['onAction']): DataColumn<Row>[] {
  return [
    {
      id: 'key',
      header: 'Key',
      hideable: false,
      width: '13rem',
      cell: (row) => (
        <Cell row={row}>
          <KeyName keyItem={row.key} wrap={false} />
        </Cell>
      ),
    },
    {
      id: 'permissions',
      header: 'Permissions',
      cell: (row) => (
        <Cell row={row}>
          <Permissions scopes={row.key.scopes} wrap={false} />
        </Cell>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      width: '6.5rem',
      cell: (row) => (
        <Cell row={row}>
          <time dateTime={row.key.createdAt}>{formatDate(row.key.createdAt)}</time>
        </Cell>
      ),
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      width: '6.5rem',
      cell: (row) => (
        <Cell row={row}>
          <LastUsed value={row.key.lastUsedAt} />
        </Cell>
      ),
    },
    {
      id: 'expires',
      header: 'Expires',
      width: '11rem',
      cell: (row) => (
        <Cell row={row}>
          <Expiry row={row} />
        </Cell>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: '10rem',
      cell: (row) => (
        <Cell row={row}>
          <StatusText state={row.state} />
        </Cell>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      hideable: false,
      width: '13.5rem',
      cell: (row) => <Actions row={row} onAction={onAction} />,
    },
  ];
}

/**
 * Every key in the project, newest first, on the shared table. Phones get a
 * card per key with the same facts in the same order.
 */
export function KeysList({ keys, now, onAction }: KeysListProps) {
  const rows: Row[] = keys.map((key) => ({ key, state: keyState(key, keys, now) }));
  return (
    <DataTable
      caption="API keys"
      data={rows}
      columns={columnsFor(onAction)}
      getRowId={(row) => row.key.id}
      rowLabel={(row) => keyLabel(row.key)}
      renderCard={(row) => <KeyCard row={row} onAction={onAction} />}
      minWidth="66rem"
    />
  );
}

/** The list while it loads, in the shared table's own skeleton. */
export function KeysListSkeleton() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading API keys
      </p>
      <DataTable
        caption="Loading API keys"
        data={[]}
        columns={columnsFor(() => undefined)}
        getRowId={(row) => row.key.id}
        rowLabel={(row) => keyLabel(row.key)}
        renderCard={() => null}
        minWidth="66rem"
        loading
      />
    </div>
  );
}

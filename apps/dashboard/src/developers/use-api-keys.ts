// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ApiKeyListItem, ApiKeysApi, ApiKeyView } from '../data/api-keys';
import { DataError } from '../data/client';

export type KeyList =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | {
      status: 'ready';
      items: readonly ApiKeyListItem[];
      nextCursor: string | null;
      loadingMore: boolean;
      moreError: unknown;
    };

interface Loaded {
  project: string;
  list: KeyList;
}

const isAbort = (error: unknown) => error instanceof DataError && error.kind === 'aborted';

/**
 * The project's keys, newest first. A reload after a change keeps the rows on
 * screen until the new answer arrives, so the table never jumps to a skeleton.
 */
export function useApiKeys(api: ApiKeysApi, project: string) {
  const [loaded, setLoaded] = useState<Loaded>({ project, list: { status: 'loading' } });
  const [version, setVersion] = useState(0);

  // A different project starts from the skeleton: its rows are not these.
  const list: KeyList = loaded.project === project ? loaded.list : { status: 'loading' };

  useEffect(() => {
    const controller = new AbortController();
    api.list(project, { signal: controller.signal }).then(
      (page) => {
        setLoaded({
          project,
          list: {
            status: 'ready',
            items: page.items,
            nextCursor: page.nextCursor,
            loadingMore: false,
            moreError: null,
          },
        });
      },
      (error: unknown) => {
        if (!isAbort(error)) setLoaded({ project, list: { status: 'error', error } });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, project, version]);

  const reload = useCallback(() => {
    setLoaded((current) =>
      current.list.status === 'error' ? { project, list: { status: 'loading' } } : current,
    );
    setVersion((v) => v + 1);
  }, [project]);

  const loadMore = useCallback(() => {
    if (list.status !== 'ready' || list.nextCursor === null || list.loadingMore) return;
    const cursor = list.nextCursor;
    setLoaded({ project, list: { ...list, loadingMore: true, moreError: null } });
    api.list(project, { cursor }).then(
      (page) => {
        setLoaded((current) =>
          current.project !== project || current.list.status !== 'ready'
            ? current
            : {
                project,
                list: {
                  ...current.list,
                  items: [...current.list.items, ...page.items],
                  nextCursor: page.nextCursor,
                  loadingMore: false,
                },
              },
        );
      },
      (error: unknown) => {
        setLoaded((current) =>
          current.project !== project || current.list.status !== 'ready'
            ? current
            : { project, list: { ...current.list, loadingMore: false, moreError: error } },
        );
      },
    );
  }, [api, list, project]);

  /** Puts the server's answer for one key into its row, before the reload confirms the rest. */
  const update = useCallback(
    (view: ApiKeyView) => {
      setLoaded((current) =>
        current.project !== project || current.list.status !== 'ready'
          ? current
          : {
              project,
              list: {
                ...current.list,
                items: current.list.items.map((item) =>
                  item.id === view.id ? { ...view, lastUsedAt: item.lastUsedAt } : item,
                ),
              },
            },
      );
    },
    [project],
  );

  return { list, reload, loadMore, update };
}

// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { AlertDialog, Button } from '@ujira/ui';
import { Ban, CircleAlert, CircleCheck, KeyRound, Plus, RotateCw } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';

import { apiKeysApi, type ApiKeyListItem } from '../data/api-keys';
import { referenceOf } from '../data/client';
import { useDataClient } from '../data/provider';
import { formatDateTime } from '../patterns/dates';
import { EmptyState } from '../patterns/empty-state';
import { ErrorState } from '../patterns/error-state';
import { PageHeader } from '../patterns/page-header';
import { NAV_ITEMS } from '../shell/nav';
import { PLACEHOLDERS } from '../shell/placeholders';
import { keyLabel, overlapEnds } from './key-status';
import { KeysList, KeysListSkeleton, type KeyAction } from './keys-list';
import { RevealKeyDialog, type RevealedKey } from './reveal-key-dialog';
import { StepUpCancelled, StepUpProvider, useStepUp } from './step-up';
import { useApiKeys } from './use-api-keys';

// The form and its controls load when someone opens it, so the list itself
// stays within the page budget.
const CreateKeyDialog = lazy(() =>
  import('./create-key-dialog').then((loaded) => ({ default: loaded.CreateKeyDialog })),
);

/** How long a rotated key keeps working, so software can move to its successor. */
export const ROTATION_OVERLAP_HOURS = 24;

const DEVELOPERS = NAV_ITEMS.find((item) => item.segment === 'developers');

interface Notice {
  tone: 'done' | 'failed';
  text: string;
  reference?: string | undefined;
}

interface Confirming {
  action: KeyAction;
  key: ApiKeyListItem;
}

const NOTICE =
  'mt-4 flex items-start gap-2 rounded-control border border-rule bg-surface p-3 text-body-s text-text';

function Header({ action }: { action: ReactNode }) {
  return (
    <PageHeader
      title={DEVELOPERS?.label ?? 'Developers'}
      summary={DEVELOPERS?.summary ?? ''}
      action={action}
    />
  );
}

function SectionHeading({ headingRef }: { headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="flex max-w-prose flex-col gap-1">
      <h2
        id="api-keys-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-body font-semibold text-text"
      >
        API keys
      </h2>
      <p className="text-body-s text-text-secondary">
        Each key lets your own software or an agent use the UJIRA API for this project, within the
        permissions you give it. The whole key is shown once, when it is made.
      </p>
    </div>
  );
}

/** The page before the project in the URL can be read, at the size it will have. */
export function ApiKeysScreenSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <Header
        action={
          <Button variant="primary" icon={<Plus aria-hidden="true" strokeWidth={1.5} />} disabled>
            Create API key
          </Button>
        }
      />
      <section className="flex flex-col gap-4">
        <SectionHeading />
        <KeysListSkeleton />
      </section>
    </div>
  );
}

export function ApiKeysScreen({ project }: { project: string }) {
  return (
    <StepUpProvider project={project}>
      <Screen key={project} project={project} />
    </StepUpProvider>
  );
}

function Screen({ project }: { project: string }) {
  const client = useDataClient();
  const api = useMemo(() => apiKeysApi(client), [client]);
  const { list, reload, loadMore, update } = useApiKeys(api, project);
  const { withStepUp } = useStepUp();

  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [working, setWorking] = useState(false);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [revealFocus, setRevealFocus] = useState<'create' | 'heading'>('create');

  const now = new Date();

  // After a revoke the button that opened the confirmation goes away with the
  // key's actions, so focus moves to the list heading instead of the page.
  // The dialog hands focus back on a timer of its own as it closes, so this
  // waits for that first.
  const focusHeading = useRef(false);
  useEffect(() => {
    if (confirming !== null || !focusHeading.current) return;
    focusHeading.current = false;
    const timer = setTimeout(() => {
      heading.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [confirming]);

  async function confirm(target: Confirming) {
    const label = keyLabel(target.key);
    setWorking(true);
    setNotice(null);
    try {
      if (target.action === 'revoke') {
        update(await withStepUp(() => api.revoke(project, target.key.id)));
        focusHeading.current = true;
        setNotice({
          tone: 'done',
          text: `${label} is revoked. Software still using it stops working within 30 seconds.`,
        });
      } else {
        const rotated = await withStepUp(() =>
          api.rotate(project, target.key.id, ROTATION_OVERLAP_HOURS),
        );
        setRevealFocus('heading');
        setRevealed({
          secret: rotated.key,
          label: `Replacement key for ${label}`,
          previousKeyExpiresAt: rotated.previousKeyExpiresAt,
        });
      }
      setConfirming(null);
      reload();
    } catch (error) {
      if (error instanceof StepUpCancelled) {
        // Nothing ran. The confirmation stays open so they can try again.
        return;
      }
      setConfirming(null);
      setNotice({
        tone: 'failed',
        text: `${label} was not ${target.action === 'revoke' ? 'revoked' : 'rotated'}, and nothing changed. Try again in a moment.`,
        reference: referenceOf(error),
      });
    } finally {
      setWorking(false);
    }
  }

  let body: ReactNode;
  if (list.status === 'loading') {
    body = <KeysListSkeleton />;
  } else if (list.status === 'error') {
    const reference = referenceOf(list.error);
    body = (
      <ErrorState
        title="Your API keys did not load"
        reference={reference}
        actions={
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        }
      >
        Nothing was changed. Try again. If it keeps happening, write to support@ujira.co
        {reference === undefined ? '.' : ' and quote the reference below.'}
      </ErrorState>
    );
  } else if (list.items.length === 0) {
    body = (
      <EmptyState icon={{ lucide: KeyRound }} title={PLACEHOLDERS.developers.title}>
        {PLACEHOLDERS.developers.body}
      </EmptyState>
    );
  } else {
    body = (
      <>
        <KeysList
          keys={list.items}
          now={now}
          onAction={(action, key) => {
            setNotice(null);
            setConfirming({ action, key });
          }}
        />
        {list.nextCursor === null ? null : (
          <div className="flex flex-col items-start gap-2">
            <Button variant="secondary" loading={list.loadingMore} onClick={loadMore}>
              Show more keys
            </Button>
            {list.moreError === null ? null : (
              <p role="alert" className="text-body-s text-text">
                The next keys did not load. Try again.
              </p>
            )}
          </div>
        )}
      </>
    );
  }

  const target = confirming;
  const targetLabel = target === null ? '' : keyLabel(target.key);

  return (
    <div className="flex flex-col gap-8">
      <Header
        action={
          <Button
            ref={createButton}
            variant="primary"
            icon={<Plus aria-hidden="true" strokeWidth={1.5} />}
            disabled={list.status === 'loading'}
            onClick={() => {
              setNotice(null);
              setCreating(true);
            }}
          >
            Create API key
          </Button>
        }
      />

      <section aria-labelledby="api-keys-heading" className="flex flex-col gap-4">
        {/*
         * The live region is always there and has no height of its own, so a
         * notice is announced when it arrives and nothing moves while it is empty.
         */}
        <div>
          <SectionHeading headingRef={heading} />
          <div role="status">
            {notice?.tone === 'done' ? (
              <p className={NOTICE}>
                <CircleCheck
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span>{notice.text}</span>
              </p>
            ) : null}
          </div>
          {notice?.tone === 'failed' ? (
            <div role="alert" className={NOTICE}>
              <CircleAlert
                aria-hidden="true"
                strokeWidth={1.5}
                className="mt-0.5 size-4 shrink-0"
              />
              <p>
                {notice.text}
                {notice.reference === undefined ? null : (
                  <>
                    {' '}
                    Reference{' '}
                    <span className="font-mono text-data select-all">{notice.reference}</span>
                  </>
                )}
              </p>
            </div>
          ) : null}
        </div>
        {body}
      </section>

      {creating ? (
        <Suspense fallback={null}>
          <CreateKeyDialog
            api={api}
            project={project}
            now={now}
            onCancel={() => {
              setCreating(false);
            }}
            onCreated={(issued) => {
              setCreating(false);
              setRevealFocus('create');
              setRevealed({ secret: issued.key, label: `Key for ${keyLabel(issued)}` });
              reload();
            }}
          />
        </Suspense>
      ) : null}

      {target?.action === 'revoke' ? (
        <AlertDialog
          key={`revoke-${target.key.id}`}
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          title={`Revoke ${targetLabel}?`}
          description={
            <p>
              Software using this key stops working within 30 seconds, and the key cannot be turned
              back on. If you need access again, create a new key.
            </p>
          }
          confirmLabel="Revoke key"
          confirmIcon={<Ban aria-hidden="true" strokeWidth={1.5} />}
          confirmationWord={targetLabel}
          pending={working}
          onConfirm={() => void confirm(target)}
        />
      ) : null}

      {target?.action === 'rotate' ? (
        <AlertDialog
          key={`rotate-${target.key.id}`}
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          title={`Rotate ${targetLabel}?`}
          description={
            <p>
              UJIRA makes a new key with the same name, permissions and lifetime, and shows it to
              you once. The old key keeps working for {ROTATION_OVERLAP_HOURS} hours, until{' '}
              {formatDateTime(overlapEnds(target.key, now, ROTATION_OVERLAP_HOURS))}, so you can
              switch your software over. Then it stops.
            </p>
          }
          confirmLabel="Rotate key"
          confirmIcon={<RotateCw aria-hidden="true" strokeWidth={1.5} />}
          confirmationWord={targetLabel}
          pending={working}
          onConfirm={() => void confirm(target)}
        />
      ) : null}

      {revealed === null ? null : (
        <RevealKeyDialog
          revealed={revealed}
          returnFocus={revealFocus === 'create' ? createButton : heading}
          onClose={() => {
            setRevealed(null);
          }}
        />
      )}
    </div>
  );
}

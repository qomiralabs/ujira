// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Input,
} from '@ujira/ui';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
  type ReactNode,
} from 'react';

import { ApiProblem, referenceOf } from '../data/client';
import { useDataClient } from '../data/provider';
import { needsStepUp, sessionApi, STEP_UP_CODE_INVALID, StepUpCode } from '../data/session';

/** The person closed the step up without giving a code, so the action did not run. */
export class StepUpCancelled extends Error {
  override readonly name = 'StepUpCancelled';
  constructor() {
    super('step up cancelled');
  }
}

interface StepUp {
  /**
   * Runs the action. When the API wants a fresh second factor, asks for the
   * code, then runs the action once more. Rejects with StepUpCancelled if the
   * person closes the prompt instead.
   */
  withStepUp: <T>(action: () => Promise<T>) => Promise<T>;
}

const StepUpContext = createContext<StepUp | null>(null);

export function useStepUp(): StepUp {
  const value = useContext(StepUpContext);
  if (value === null) throw new Error('useStepUp needs a StepUpProvider');
  return value;
}

export function StepUpProvider({ project, children }: { project: string; children: ReactNode }) {
  const client = useDataClient();
  const session = useMemo(() => sessionApi(client), [client]);
  const [pending, setPending] = useState<((passed: boolean) => void) | null>(null);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        setPending(() => resolve);
      }),
    [],
  );

  const value = useMemo<StepUp>(
    () => ({
      withStepUp: async <T,>(action: () => Promise<T>): Promise<T> => {
        try {
          return await action();
        } catch (error) {
          if (!needsStepUp(error)) throw error;
          if (!(await ask())) throw new StepUpCancelled();
          return action();
        }
      },
    }),
    [ask],
  );

  return (
    <StepUpContext value={value}>
      {children}
      {pending === null ? null : (
        <StepUpDialog
          verify={(code) => session.stepUp(project, code)}
          onDone={(passed) => {
            pending(passed);
            setPending(null);
          }}
        />
      )}
    </StepUpContext>
  );
}

interface StepUpDialogProps {
  verify: (code: string) => Promise<unknown>;
  onDone: (passed: boolean) => void;
}

function StepUpDialog({ verify, onDone }: StepUpDialogProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<ReactNode>(undefined);
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    const parsed = StepUpCode.safeParse(code.trim());
    if (!parsed.success) {
      setError('Enter the 6 digits your authenticator app shows.');
      input.current?.focus();
      return;
    }
    setChecking(true);
    setError(undefined);
    try {
      await verify(parsed.data);
      onDone(true);
    } catch (failure) {
      setChecking(false);
      setCode('');
      if (failure instanceof ApiProblem && failure.code === STEP_UP_CODE_INVALID) {
        setError('That code did not work. Enter the newest code your app shows.');
      } else {
        const reference = referenceOf(failure);
        setError(
          `Your code could not be checked just now. Try again in a moment.${
            reference === undefined ? '' : ` Reference ${reference}.`
          }`,
        );
      }
      input.current?.focus();
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
    >
      <DialogContent pending={checking} className="max-w-md">
        <DialogTitle>Confirm it&apos;s you</DialogTitle>
        <DialogDescription>
          Enter the 6-digit code from your authenticator app. UJIRA asks for a fresh code before any
          change to an API key.
        </DialogDescription>
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field label="Code" error={error}>
            <Input
              ref={input}
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6));
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={6}
              disabled={checking}
              className="max-w-40 font-mono tracking-[0.3em]"
            />
          </Field>
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={checking}
              onClick={() => {
                onDone(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={checking}>
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

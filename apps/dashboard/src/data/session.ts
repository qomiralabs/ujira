// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The step up: a fresh code from the person's authenticator app, which the
// API asks for before an action UJIRA decides alone, such as changing an API
// key. It answers STEP_UP_REQUIRED until one has been given in the last five
// minutes.

import * as z from 'zod/mini';

import { ApiProblem, type DataClient } from './client';

/** The problem code an action answers with when it needs a fresh second factor. */
export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';
/** The code was wrong or too old. */
export const STEP_UP_CODE_INVALID = 'STEP_UP_CODE_INVALID';

export const StepUpCode = z.string().check(z.regex(/^[0-9]{6}$/));

export function needsStepUp(error: unknown): boolean {
  return error instanceof ApiProblem && error.code === STEP_UP_REQUIRED;
}

export function sessionApi(client: DataClient) {
  return {
    stepUp(project: string, code: string): Promise<undefined> {
      return client.request({
        method: 'POST',
        path: '/v1/session/step-up',
        project,
        body: { code },
        schema: z.undefined(),
      });
    },
  };
}

export type SessionApi = ReturnType<typeof sessionApi>;

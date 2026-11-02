// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How a KMS backend gets its credentials. Only through the platform's
// managed OIDC: a role and a web identity token file that the platform
// rotates. A static key in the environment would outlive every rotation and
// leak with the environment, so its mere presence stops the process, even
// though the SDK would have preferred it silently.

import { InvalidInputError } from '@ujira/chain-adapter';

export const KMS_REGION_VARIABLE = 'UJIRA_KMS_REGION';
/** Frankfurt, where the production keys live. */
export const DEFAULT_KMS_REGION = 'eu-central-1';

const STATIC_CREDENTIALS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;
const REQUIRED = ['AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE'] as const;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

export interface KmsEnvironment {
  readonly region: string;
}

/** The checked environment, or InvalidInputError naming the variable and never its value. */
export function readKmsEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): KmsEnvironment {
  for (const name of STATIC_CREDENTIALS) {
    if (env[name] !== undefined) throw new InvalidInputError({ issues: [`${name} (forbidden)`] });
  }
  for (const name of REQUIRED) {
    if ((env[name] ?? '') === '') throw new InvalidInputError({ issues: [`${name} (missing)`] });
  }
  const region = env[KMS_REGION_VARIABLE] ?? DEFAULT_KMS_REGION;
  if (!REGION.test(region)) {
    throw new InvalidInputError({ issues: [`${KMS_REGION_VARIABLE} (invalid)`] });
  }
  return { region };
}

# @ujira/signer

The backends behind the chain adapter's signer ports, and the signer services that hold signing permission. Callers reach a service through `RemoteSigner` or `RemoteAttesterSigner`.

## Running a service

Each service is its own process, and the entry point that runs fixes its role. Build with `pnpm --filter @ujira/signer build`, then:

| Service  | Command                                      | Serves                             | Callers              |
| -------- | -------------------------------------------- | ---------------------------------- | -------------------- |
| Chain    | `pnpm --filter @ujira/signer start:chain`    | `executor`, `fee_sponsor`, `sep10` | `payouts`, `adapter` |
| Agent    | `pnpm --filter @ujira/signer start:agent`    | `managed_agent`                    | `payouts`            |
| Attester | `pnpm --filter @ujira/signer start:attester` | `attester`                         | `identity`           |

Before a port opens, each one reads its environment, builds its backend and verifies its keys. Any failure logs `startup_refused` with codes and variable names, never values, and exits 1 with nothing listening.

- **Chain:** every key configuration pins must control its pinned address, and no pinned key may be local in production.
- **Attester:** the key it holds on every configured network must not be a public test key, in any environment but `test`.
- **Agent:** it holds no fixed key to check, because each key comes from `managed_signers`. A local backend in production still refuses to start.

## Environment

| Variable                                      | For                 | Meaning                                                                         |
| --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `NODE_ENV`                                    | all                 | Only `test` lets a public test attester key through                             |
| `PORT`                                        | all                 | The port to listen on                                                           |
| `UJIRA_SIGNER_HOST`                           | all                 | The address to bind; `127.0.0.1` when left out                                  |
| `UJIRA_SIGNER_BACKEND`                        | all                 | `local` or `aws_kms`                                                            |
| `UJIRA_NETWORKS_CONFIG`                       | all                 | The networks document as JSON; it holds references and pins, never secrets      |
| `UJIRA_SIGNER_TOKEN_PAYOUTS`                  | chain, agent        | The payouts caller's service token, at least 32 characters                      |
| `UJIRA_SIGNER_TOKEN_ADAPTER`                  | chain               | The adapter caller's service token                                              |
| `UJIRA_SIGNER_TOKEN_IDENTITY`                 | attester            | The identity caller's service token                                             |
| `UJIRA_SIGNER_LOCAL_SEED`                     | `local`             | 64 hex characters; refused in production                                        |
| `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` | `aws_kms`           | Set by the platform's OIDC; static AWS keys in the environment stop the process |
| `UJIRA_KMS_REGION`                            | `aws_kms`           | Defaults to `eu-central-1`                                                      |
| `UJIRA_ATTESTER_KMS_KEY_ID`                   | attester, `aws_kms` | The attester's key, used on every configured network                            |

## What deployment still needs

The processes run today, but they stop short of signing real work until these exist:

- **An AWS account and keys.** The `aws_kms` backend has only run against stand ins. It needs real keys, one role per service that may sign only with its own keys, and OIDC from the host.
- **A host and a private network.** Each service needs a private service, a health check on `GET /v1/health`, `UJIRA_SIGNER_HOST` set to its private interface, and a secret manager for the tokens and the networks document. A container image is not built here.
- **The real stores.** All of them are empty in-memory versions, so each service refuses anything that needs a record:
  - The mandate index, over the registry that #102 fills, for all three services.
  - The sponsorship ledger, for chain.
  - `managed_signers`, for agent. The table and its repository are merged (#163); the port over them is not written.
  - A rate limiter shared across instances, for agent. The in-memory one counts per process and allows 60 requests a minute.
  - `ujira.attestation_pending`, for attester (#165).
- **The check against `ops.signing_keys`.** `verifyServedKeys` exists and is not called yet, because nothing reads the table for it. Chain and attester should both call it at startup.
- **SEP-10 anchors.** The networks document names each anchor's key but not its server account or domains, so the chain service refuses every challenge until it does.
- **Attester keys per network.** One key id serves every configured network. Run one attester per network if they must differ.

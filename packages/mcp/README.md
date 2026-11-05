# @ujira/mcp

The UJIRA MCP server: a thin adapter over the API, so agents and MCP clients can check payouts, read receipts and read mandates. A tool is a row in `src/tools.ts` naming a route in the contract in `@ujira/api-schema`, which supplies its inputs and checks its results, so the server cannot describe a route differently from the API.

It is developed here and not yet published.

## Run it

```sh
pnpm --filter @ujira/mcp... build
UJIRA_API_URL=https://your-api-host UJIRA_API_KEY=your-key node packages/mcp/dist/main.js
```

| Variable        | What it is                                                          |
| --------------- | ------------------------------------------------------------------- |
| `UJIRA_API_URL` | The API's origin. It must be https, unless it is this machine       |
| `UJIRA_API_KEY` | An API key from the dashboard. Anything not in that form is refused |

The server speaks MCP over stdio. Nothing but the protocol reaches stdout, and it writes one line to stderr when it cannot start.

## The key to give it

Create a key with only what these tools need, and no write scope:

| Tool                           | Scope           |
| ------------------------------ | --------------- |
| `list_payouts`, `get_payout`   | `payouts:read`  |
| `list_receipts`, `get_receipt` | `receipts:read` |
| `list_mandates`, `get_mandate` | `mandates:read` |

The `read_only` preset also grants other read scopes, so these three are the least it can hold.

## What it will never do

- **Hold a principal's key.** It takes an API key from its environment, and refuses a wallet secret given in its place. No tool has an input for a key, a secret or a seed.
- **Sign anything.** UJIRA is non-custodial, and a principal signs in their own wallet.
- **Let a caller choose a chain.** The router decides, so no tool offers a network as an input.
- **Echo what it was given.** A refusal names the field and never the value, so something pasted by mistake does not end up in a transcript.

Results hold what the API returns, which can include a recipient's display name, and they go to whatever client called the tool. The server does not log them.

## Adding a tool

Add a row to `TOOLS` naming the route and the one scope it needs, then add its call to `CALLS` in `src/tools.test.ts`. The test fails until you do.

`src/safety.ts` holds every tool to the rules above. The server refuses to start with a tool that has an input for a secret or a chain, at any depth, an object taking inputs nobody named, or a write scope without being marked as a write. `src/safety.test.ts` also checks what the package can reach: nothing that can sign, or reach a chain or a database.

A word list has limits. It cannot know that an input named `payload` is a signed transaction, so a person reviewing a new tool still has to read what it takes.

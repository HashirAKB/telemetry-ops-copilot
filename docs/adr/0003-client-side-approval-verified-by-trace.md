# ADR 0003: Human approval enforced by the client, default-deny, verified from the trace

**Status:** accepted

## Context
`create_incident` and `restart_device` change the world. An LLM can be tricked (prompt injection through a tool result) or simply wrong. MCP tool annotations such as `readOnlyHint` are hints supplied by the server and are not a security boundary.

## Decision
- The agent decides which tools need approval from its *own* tool definitions (`src/tools/definitions.ts`): anything not explicitly `read` requires a human.
- Order of checks for every call: allow-list, then zod argument validation, then approval, then the MCP call. A malformed destructive call is rejected before a human is bothered.
- Approvers: terminal y/n (`CliApprover`), HTTP approve/deny with a fail-safe timeout that denies (`HttpApprover`), fixed policy for tests/evals (`PolicyApprover`).
- Every approval is a span in the trace, as a child of the tool span. Evals compute safety from the trace and cross-check the database, not from what the agent reports.

## Consequences
- A prompt-injected model can *ask* for a restart, but cannot perform one without a human saying yes.
- The MCP server itself does not enforce approval; other MCP hosts (Claude Desktop) apply their own confirmation. A production deployment would add server-side authorization too (defence in depth).

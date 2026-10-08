# Diagnostics Channels: a one-pager for TC55

Status: exploratory pre-proposal. Not yet a TC55 work item.

## The problem

Every server-side JavaScript runtime now ships a diagnostics-channel-style pub/sub API for instrumentation. Node invented it, and Bun, Deno, and Cloudflare Workers implement it as node: compatibility. The portability is accidental. It exists because runtimes chase Node's module surface, not because anyone specified the behavior. Nobody specifies channel semantics, subscriber ordering, what untrusted code can subscribe to, or which channel names are safe to depend on. Instrumentation vendors (OpenTelemetry, Sentry, Datadog) still ship per-runtime glue, and every new runtime API designs its observability story against a blank page.

## What exists and what's missing

- Node: `node:diagnostics_channel` is stable. `TracingChannel` is still experimental even there.
- Bun, Deno, Cloudflare Workers: Node-compatible implementations. A first-pass probe across all four lives in this repo's [divergence matrix](divergence-matrix/). The core converges, including the tracing lifecycle and store binding. Error handling and a few metadata shapes do not.
- TC39: `AsyncContext` (Stage 2) standardizes context propagation, the store subscribers bind to. It does not define an event surface.
- W3C: Trace Context and Baggage standardize wire headers, not in-process instrumentation.
- No standards body has the channel surface on its work list, per TC55's current work items and public meeting notes as of October 2026.

## The proposal

TC55 standardizes the semantics of the channel primitive:

- named channels (string or symbol), synchronous publish, defined subscriber ordering
- zero cost when there are no subscribers, with `hasSubscribers` so emitters can skip building payloads
- a conforming module surface. `node:diagnostics_channel` is a conforming implementation. We do not standardize the `node:` prefix, following the Minimum Common API approach.

Layered on top, in order:

1. **Channel primitive** (the above). Ships with no dependencies.
2. **TracingChannel**: the five-event operation lifecycle (start, end, asyncStart, asyncEnd, error) with one shared context object and store binding. This layer depends on TC39 `AsyncContext`, so it should track that proposal's timeline rather than freeze against Node's current `AsyncLocalStorage` semantics.
3. **Well-known names**: a registry of blessed channels, starting with `http.server.request` and friends, with names aligned to OpenTelemetry semantic conventions so vendor mapping is trivial.

## Hard problems to answer before adoption

- **Isolation.** Channels cross trust boundaries. Workers already forwards messages through structured clone for safety in multi-tenant isolates. The spec needs explicit realm and agent scoping and a rule for what untrusted code may subscribe to.
- **Divergence.** Nobody has catalogued where the four runtimes differ. A test matrix is both the problem statement and the forcing function.
- **Node's stake.** Node's API becomes the standard and its still-experimental TracingChannel gets pressure to stabilize. That is the pitch, not the objection.

## Why now

The Fetch Server proposal is the first TC55 work item with an instrumentation requirement it cannot express on its own (see its issue #7). Handlers get wrapped for tracing today via global patching and module hooks, both accidents of the platform. Server-exchange channels would be the first well-known names with a live customer.

## The ask

1. Two runtimes co-sign this page. Cloudflare and Node are the natural first pair.
2. A divergence test matrix across Node, Deno, Bun, and Workers. A first pass is in this repo, see `divergence-matrix/`.
3. A proposal repo under the WinterTC55 org and an agenda slot.

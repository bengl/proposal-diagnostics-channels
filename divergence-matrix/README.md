# Divergence matrix (work in progress)

Goal: catalogue where diagnostics-channel implementations differ across Node, Deno, Bun, and Cloudflare Workers. The result is the problem statement for the TC55 proposal and the seed of its conformance suite.

## Method

A runnable test suite (to live in `tests/`) probes each runtime through its diagnostics channel module and records results here. Node's own docs are the reference behavior where all four agree, and any point where they don't is a row worth having.

## Surface to probe

| Area | Questions |
|------|-----------|
| Module surface | `channel()`, `subscribe()`, `unsubscribe()`, `hasSubscribers()` present? Singleton per name? |
| Naming | String names, symbol names, both? Do symbol-named channels subscribe identically? |
| Publish | Synchronous dispatch? Subscriber order defined? Errors thrown by a subscriber? |
| No subscribers | Observable cost? `hasSubscribers` accurate? |
| TracingChannel | `tracingChannel()` present? Which of the five events? `tracePromise`, `traceCallback`, `traceSync`? |
| Stores | `bindStore`, `runStores` present? Behavior with `AsyncLocalStorage`? |
| Isolation | What can untrusted code subscribe to? Any cross-isolate forwarding, and what serialization applies? |
| Built-in channels | Which channels does the runtime itself publish, and with what message shapes? |

## Results

Empty until the suite runs. First pass planned against Node LTS, Deno stable, Bun stable, and Workers with `nodejs_compat`.

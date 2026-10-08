# Divergence matrix

Goal: catalogue where diagnostics-channel implementations differ across Node, Deno, Bun, and Cloudflare Workers. The result is the problem statement for the TC55 proposal and the seed of its conformance suite.

## Method

`tests/probe.mjs` runs the same battery everywhere through each runtime's diagnostics channel module and returns the results as JSON. `tests/cli.mjs` prints them for Node, Bun, and Deno. `worker/index.mjs` serves them over HTTP under Workers. Node's docs are the reference behavior where all four agree, and any point where they don't is a row worth having.

How to run:

```
node tests/cli.mjs
bun tests/cli.mjs
deno run -A tests/cli.mjs
npx wrangler dev --port 8791 & curl localhost:8791/
```

Raw output for the tested versions lives in `results/`.

## Environment

| Runtime | Version | How |
|---------|---------|-----|
| Node | v26.5.0 | `node tests/cli.mjs` |
| Deno | 2.9.7 | `deno run -A tests/cli.mjs` |
| Bun | 1.3.14 | `bun tests/cli.mjs` |
| Workers | wrangler 4.148.0, local workerd | `wrangler dev`, `nodejs_compat`, compat date 2026-09-01 |

The Workers results come from the local workerd binary. Deployed Workers should be the same engine, but that assumption is worth a re-run in a real deployment before anyone quotes it.

## Results

| Probe | Node 26.5.0 | Deno 2.9.7 | Bun 1.3.14 | Workers |
|-------|-------------|-------------|------------|---------|
| Module surface (`channel`, `subscribe`, `unsubscribe`, `hasSubscribers`) | pass | pass | pass | pass |
| Node-only exports (`BoundedChannel`, `boundedChannel`) | present | absent | absent | absent |
| Channel singleton per name, `subscribe`/`publish`/`unsubscribe` on it | pass | pass | pass | pass, no `name` property |
| String names: subscribe, publish, `hasSubscribers` toggles, unsubscribe | pass | pass | pass | pass, `unsubscribe` returns `undefined` |
| Symbol names | pass | pass | pass | pass |
| Subscriber dispatch order | registration order | registration order | registration order | registration order |
| Subscriber error handling | see findings | see findings | see findings | see findings |
| `TracingChannel` surface, five events, `subscribe` helper | pass | pass | pass | pass, subchannels expose no `name` |
| `tracePromise` | pass | pass | pass | pass |
| `tracePromise` rejection, `error` event, `ctx.error` | pass | pass | pass | pass |
| `traceCallback` | pass | pass | pass | pass |
| `traceSync` | pass | pass | pass | pass |
| `bindStore` / `runStores` with `AsyncLocalStorage` | pass | pass | pass | pass |
| TracingChannel store restore across `asyncStart` | pass | pass | pass | pass |

## Findings

**Subscriber error handling is the big divergence, with three distinct behaviors.**

* Node and Bun: `publish` returns normally, the remaining subscribers still run, and the error surfaces later as an uncaught exception. A handler registered after the publish still receives it.
* Deno: `publish` returns normally and the remaining subscribers run, but the error only reaches an `uncaughtException` handler that was registered before the publish. Otherwise it disappears entirely. No crash, no report at exit.
* Workers: `publish` throws synchronously and the remaining subscribers do not run.

None of this is documented by any of the four. Any instrumentation library that can throw or that depends on later subscribers seeing the message after a bad one has to know which runtime it is on. This is the clearest argument for the spec.

**Workers has small metadata gaps.** `Channel.name` is `undefined`, the `TracingChannel` subchannels expose no `name`, and the module-level `unsubscribe()` returns `undefined` instead of `true`. Subscriptions themselves work, including `hasSubscribers` toggling correctly. These are exactly the kind of quiet shape differences a spec has to pin for portable tooling.

**Everything else converges.** The five-event tracing lifecycle, the trace helpers, context identity across events, store binding, and store restore behave identically in all four runtimes, including the ALS integration. The core is already de facto standard. Error handling and metadata shape are what remain.

## Not probed by the suite

* **Isolation.** What untrusted code can subscribe to, and any cross-isolate forwarding. Workers forwards some built-in channels to Tail Workers through structured clone, per Cloudflare's docs, and the other runtimes have no equivalent surface. Needs a manual audit and probably a per-runtime threat model.
* **Built-in channels.** The inventory of channels each runtime publishes itself, and their message shapes. Nothing in the API exposes this, so it has to be audited from docs and source.

# Divergence matrix

Goal: catalogue where diagnostics-channel implementations differ across Node, Deno, Bun, and Cloudflare Workers. The result is the problem statement for the TC55 proposal and the seed of its conformance suite.

## Method

`tests/probe.mjs` runs the same battery everywhere through each runtime's diagnostics channel module and returns the results as JSON. `tests/cli.mjs` prints them for Node, Bun, and Deno. `worker/index.mjs` serves them over HTTP under Workers. The probe asserts Node's behavior as the reference, so a fail means a divergence from Node, not necessarily a bug. Any point where the runtimes disagree is a row worth having.

How to run, from the repo root:

```
./divergence-matrix/run-all.sh    # node, bun, deno
# workers: capture the version, start wrangler, curl the worker
npx wrangler --version > divergence-matrix/results/workers-env.txt
npx wrangler dev --port 8791 & curl localhost:8791/ > divergence-matrix/results/workers.json
```

Raw output for the tested versions lives in `results/`, including the two older Node runs. The Wrangler version used to launch the local workerd instance is retained in `results/workers-env.txt`, since the worker cannot see its own host version. The workerd engine version itself is not captured.

## Environment

| Runtime | Version | How |
|---------|---------|-----|
| Node | v26.5.0 | `node tests/cli.mjs` |
| Node | v22.23.1, v24.18.0 | full runs, `results/node-v22.json` and `results/node-v24.json` |
| Deno | 2.9.7 | `deno run -A tests/cli.mjs` |
| Bun | 1.3.14 | `bun tests/cli.mjs` |
| Workers | wrangler 4.148.0, local workerd | `wrangler dev`, `nodejs_compat`, compat date 2026-09-01 |

The Workers results come from the local workerd binary. Deployed Workers should be the same engine, but that assumption is worth a re-run in a real deployment before anyone quotes it.

## Results

The probe asserts exact event order, one shared context object across all events, the resolved value on the context, removal that actually stops delivery, bounded callback tracing, and store restoration against a pre-existing outer store. A pass under those assertions is a strong claim.

| Probe | Node 26.5.0 (and 22, 24) | Deno 2.9.7 | Bun 1.3.14 | Workers |
|-------|--------------------------|------------|-------------|---------|
| Module surface (`channel`, `subscribe`, `unsubscribe`, `hasSubscribers`) | pass | pass | pass | pass |
| Extra exports (`BoundedChannel`, `boundedChannel`) | v26: present, v22/v24: absent | absent | absent | absent |
| Channel singleton per name, `subscribe`/`publish`/`unsubscribe` on it | pass | pass | pass | fail: no `name` property, singleton and methods fine |
| String names: subscribe, publish, unsubscribe stops delivery, `hasSubscribers` toggles | pass | pass | pass | fail: `unsubscribe` returns `undefined`, removal itself works |
| Symbol names, name delivered is the supplied symbol | pass | pass | pass | pass |
| Subscriber dispatch order | registration order | registration order | registration order | registration order |
| Subscriber error handling | pass, both errors delivered | fail: only the post-registration error delivered | pass, both errors delivered | fail: see findings |
| `TracingChannel` surface, five events, `subscribe` helper | pass | pass | pass | pass, subchannels expose no `name` |
| `tracePromise`: exact event order, one ctx, result on ctx | pass | pass | pass | pass |
| `tracePromise` rejection: exact event order, one ctx, `ctx.error` | pass | pass | pass | pass |
| `traceCallback`: exact event order, one ctx, bounded | pass | pass | pass | pass |
| `traceSync`: exact event order, one ctx | pass | pass | pass | pass |
| `bindStore` / `runStores` with `AsyncLocalStorage` | pass | pass | pass | pass |
| TracingChannel store restore against an outer store | pass | pass | pass | pass |

## Findings

**Subscriber error handling is the big divergence, with three distinct behaviors.**

The probe publishes two subscriber errors, one before any `uncaughtException` listener is registered and one after.

* Node and Bun: `publish` returns normally, the remaining subscribers still run, and both errors surface later as uncaught exceptions, delivered to a listener registered between the two publishes. Identical on Node v22.23.1, v24.18.0, and v26.5.0. Node documents the mechanism, "errors thrown in the message handler will trigger an [`'uncaughtException'`](https://nodejs.org/docs/latest/api/diagnostics_channel.html)", but not that dispatch continues.
* Deno 2.9.7: `publish` returns normally and the remaining subscribers run, but only the error published after the listener was registered is delivered. `results/deno.json` shows exactly `after-boom` delivered, with `before-boom` gone. The error published with no listener registered disappears entirely: no crash, no delivery. The probe run itself completes and exits 0, which `run-all.sh` would fail on otherwise. Not documented.
* Workers: `publish` throws synchronously and the remaining subscribers do not run. Not documented.

Any instrumentation library that can throw, or that depends on later subscribers seeing the message after a bad one, has to know which runtime it is on. This is the clearest argument for the spec.

**Workers has small metadata gaps.** `Channel.name` is `undefined`, the `TracingChannel` subchannels expose no `name`, and the module-level `unsubscribe()` returns `undefined` instead of `true`. Removal itself works: a publish after `unsubscribe` does not fire the handler, and `hasSubscribers` toggles correctly. These are exactly the kind of quiet shape differences a spec has to pin for portable tooling.

**The exports are still moving even within Node.** `BoundedChannel` and `boundedChannel` are present in Node v26.5.0 and absent in v22.23.1 and v24.18.0. A conformance suite keyed to a fixed export list would have been stale within a Node release. Whatever the spec pins has to allow the surface to grow.

**Everything else converges, under strict assertions.** Exact event order, one shared context object across events, the resolved value placed on the context, bounded callback tracing, and store restoration against a pre-existing outer store all behave identically in all four runtimes, including the `AsyncLocalStorage` integration. The core is already de facto standard. Error handling and metadata shape are what remain.

## Not probed by the suite

* **Isolation.** What untrusted code can subscribe to, and any cross-isolate forwarding. Workers forwards some built-in channels to Tail Workers through structured clone, per [Cloudflare's docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/diagnostics-channel/), and the other runtimes have no equivalent surface. Needs a manual audit and probably a per-runtime threat model.
* **Built-in channels.** The inventory of channels each runtime publishes itself, and their message shapes. Nothing in the API exposes this, so it has to be audited from docs and source.

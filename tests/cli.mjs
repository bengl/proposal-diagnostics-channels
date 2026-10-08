// CLI entry for Node, Bun, and Deno: prints the probe results as JSON.
import { run } from './probe.mjs';

const tests = await run();

let runtime = 'unknown';
let version = '';
if (typeof Bun !== 'undefined') {
  runtime = 'bun';
  version = Bun.version;
} else if (typeof Deno !== 'undefined') {
  runtime = 'deno';
  version = Deno.version.deno;
} else {
  runtime = 'node';
  version = process.version;
}

console.log(JSON.stringify({ runtime, version, tests }, null, 2));

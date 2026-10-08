import { run } from '../tests/probe.mjs';

export default {
  async fetch() {
    const tests = await run();
    return Response.json({ runtime: 'workers', version: null, tests });
  },
};

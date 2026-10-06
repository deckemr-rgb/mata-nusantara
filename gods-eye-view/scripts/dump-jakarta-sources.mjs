// One-off: dump Jakarta CCTV sources (with stream URLs) using the repo's own
// portal loader. Used to build the 5-camera prototype source pack.
import { loadJakartaSourcesFromPortal } from '../server/providers/cctv/sources.indonesia.js';

const sources = await loadJakartaSourcesFromPortal({ sourceRoot: process.cwd() });
console.log(JSON.stringify(sources));

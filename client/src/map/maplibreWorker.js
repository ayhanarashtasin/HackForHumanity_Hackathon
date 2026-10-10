// MapLibre 6 loads its tile-processing worker from a separate ES module. Bundling it through Vite's worker pipeline
// keeps its shared chunk resolvable in both `vite dev` and the production build.
// The module registers its message handler when evaluated; holding a reference stops the bundler dropping it as unused.
import * as worker from 'maplibre-gl/dist/maplibre-gl-worker.mjs';

self.maplibreWorkerModule = worker;

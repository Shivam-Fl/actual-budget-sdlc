const BUILD_OUTPUT_GLOBS = ['lib-dist/**', 'dist/**', 'build/**', '@types/**'];

/** @type {import('lage').ConfigOptions} */
module.exports = {
  pipeline: {
    typecheck: {
      type: 'npmScript',
      dependsOn: ['^typecheck'],
    },
    test: {
      type: 'npmScript',
      // `test` is cached, and its hash is built from files inside workspace
      // packages. upcoming-release-notes/ is at the repo root and belongs to no
      // package, so a note-only change cannot move that hash: lage would print
      // `» skip @actual-app/ci-actions test` and exit 0 on a note the gate
      // rejects. The gate therefore runs as its own uncached dependency.
      dependsOn: ['release-notes'],
      options: {
        outputGlob: [
          'coverage/**',
          '**/test-results/**',
          '**/playwright-report/**',
        ],
      },
    },
    'release-notes': {
      type: 'npmScript',
      // Not cached, for the reason on `test`'s dependsOn: the notes this reads
      // live outside every workspace package, so no note can appear in a cache
      // key and a cache hit would skip the gate on the one change it exists to
      // police. Only @actual-app/ci-actions defines the script; lage skips the
      // task for every other package.
      cache: false,
    },
    build: {
      type: 'npmScript',
      dependsOn: ['^build'],
      cache: true,
      options: {
        outputGlob: BUILD_OUTPUT_GLOBS,
      },
    },
    // Not cached: the script stages files into public/ and build-stats/ that
    // fall outside BUILD_OUTPUT_GLOBS, so a cache hit would skip the side
    // effects.
    'build:browser': {
      type: 'npmScript',
      dependsOn: ['^build'],
      cache: false,
    },
  },
  cacheOptions: {
    cacheStorageConfig: {
      provider: 'local',
      outputGlob: BUILD_OUTPUT_GLOBS,
    },
  },
  npmClient: 'yarn',
  concurrency: 2,
};

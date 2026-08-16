import type { NextConfig } from 'next'

const config: NextConfig = {
  // Long-lived Node server (not serverless) — required for the in-process worker.
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', '@google-cloud/bigquery'],
  // instrumentation.ts register() boots the worker — stable since Next 15, no
  // experimental flag needed.
  eslint: { ignoreDuringBuilds: true },
  // `next dev` also compiles instrumentation.ts for the edge runtime (a
  // production build drops that entry when no edge routes exist, dev keeps it).
  // The edge compiler ignores serverExternalPackages and has no node built-ins,
  // so the entire worker → tasks → registry → BigQuery → stream chain fails.
  // register() guards with NEXT_RUNTIME !== 'nodejs' so it never runs in edge;
  // alias the resolved worker path to false (empty module) to cut the chain
  // before webpack ever touches Node-only code.
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === 'edge') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path')
      // JsConfigPathsPlugin resolves @/lib/jobs/worker → this absolute path
      // before AliasPlugin sees it; the alias is then matched on the second
      // resolution pass, replacing the whole subtree with an empty module.
      config.resolve.alias = {
        ...config.resolve.alias,
        [path.resolve('./src/lib/jobs/worker')]: false,
      }
    }
    return config
  },
}

export default config

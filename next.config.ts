import type { NextConfig } from 'next'

const config: NextConfig = {
  // Long-lived Node server (not serverless) — required for the in-process worker.
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', '@google-cloud/bigquery'],
  // instrumentation.ts register() boots the worker — stable since Next 15, no
  // experimental flag needed.
  eslint: { ignoreDuringBuilds: true },
}

export default config

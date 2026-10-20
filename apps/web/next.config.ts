import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = resolve(process.cwd(), '../..');
const nextConfig: NextConfig = {
  experimental: { cpus: 2, workerThreads: false },
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingExcludes: { '/*': ['../../.memvora/**/*', '../../.env', '../../.env.*'] },
  turbopack: {
    root: workspaceRoot,
    rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } },
  },
};

export default nextConfig;

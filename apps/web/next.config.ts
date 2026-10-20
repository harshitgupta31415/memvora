import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = resolve(process.cwd(), '../..');
const nextConfig: NextConfig = {
  experimental: { cpus: 2, workerThreads: false },
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingExcludes: { '/*': ['../../.memvora/**/*', '../../.env', '../../.env.*'] },
  turbopack: {
    root: workspaceRoot,
    // Restrict this loader to the Tailwind entry so CSS Modules keep Next.js's built-in processor.
    rules: { 'globals.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } },
  },
};

export default nextConfig;

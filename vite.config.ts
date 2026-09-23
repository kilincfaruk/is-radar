/** Dashboard build: dashboard/ -> public/, served by the collector on http://localhost:4545. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  root: path.resolve(root, 'dashboard'),
  base: '/',
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  resolve: {
    alias: [
      { find: '@shared', replacement: path.resolve(root, 'src/shared') },
      { find: '@', replacement: path.resolve(root, 'dashboard/src') },
    ],
  },
  build: {
    outDir: path.resolve(root, 'public'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})

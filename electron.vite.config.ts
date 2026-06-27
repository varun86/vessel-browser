import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';
import type { ServerOptions } from 'vite';
import solid from 'vite-plugin-solid';

const devServerWatch: NonNullable<ServerOptions['watch']> = {
  ignored: [
    '**/.git/**',
    '**/.gitnexus/**',
    '**/.kilo/**',
    '**/.venv/**',
    '**/.worktrees/**',
    '**/coverage/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/out/**',
  ],
  ...(process.platform === 'linux' && process.env.VESSEL_DEV_NATIVE_WATCH !== '1'
    ? { interval: 300, usePolling: true }
    : {}),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@mozilla/readability'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'content-script': resolve(__dirname, 'src/preload/content-script.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [solid()],
    server: {
      watch: devServerWatch,
    },
    build: {
      rollupOptions: {
        input: './src/renderer/index.html',
      },
    },
  },
});

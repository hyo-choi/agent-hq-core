// 진행판 프론트 빌드: web/ 소스 → public/index.html 한 파일(CSS·JS inline). 서버(server.py)는 바꾸지 않는다
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [tailwindcss(), viteSingleFile()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: { outDir: '../public', emptyOutDir: false, target: 'es2022', modulePreload: { polyfill: false } },
  test: { root: '.', environment: 'happy-dom', include: ['web/**/*.test.{ts,tsx}'] },
});

import { defineConfig } from 'vite';

// base relativa: il build statico funziona da qualunque sottocartella (file server, GitHub Pages, itch.io)
export default defineConfig({
  base: './',
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
  build: { target: 'es2022' },
});

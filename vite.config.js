import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import path from 'path';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-syntax-highlighter') || id.includes('refractor') || id.includes('prismjs')) {
            return 'vendor-syntax';
          }
          if (id.includes('@xterm')) {
            return 'vendor-xterm';
          }
          if (id.includes('katex')) {
            return 'vendor-katex';
          }
          if (id.includes('react-markdown') || id.includes('remark-') || id.includes('rehype-') || id.includes('unified') || id.includes('micromark') || id.includes('mdast') || id.includes('hast')) {
            return 'vendor-markdown';
          }
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/zustand/')) {
            return 'vendor-react';
          }
        },
      },
    },
  },
});

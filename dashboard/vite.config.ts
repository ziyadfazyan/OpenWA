import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  appType: 'spa',

  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || '0.2.1'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },

  server: {
    port: 2886,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});

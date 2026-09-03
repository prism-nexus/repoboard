import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// With VITE_MOCK set, the app talks to src/mock and needs no server.
// Otherwise dev proxies /api and /ws to the rcb server (plan §3) on 127.0.0.1:4242.
const SERVER = 'http://127.0.0.1:4242';

export default defineConfig(() => {
  const mock = Boolean(process.env.VITE_MOCK);
  return {
    plugins: [react()],
    server: {
      proxy: mock
        ? undefined
        : {
            '/api': SERVER,
            '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
          },
    },
    build: { target: 'es2022', sourcemap: false },
  };
});

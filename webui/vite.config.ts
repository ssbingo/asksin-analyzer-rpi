import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Im Dev-Modus (npm run dev) beantwortet ein lokal laufender Core die
// API-Aufrufe; im Betrieb liefert der Core das gebaute UI selbst aus
// (ApiServer-Option `uiDir`) — dann ist alles same-origin und der Proxy
// spielt keine Rolle.
const core = 'http://127.0.0.1:8080';

const backendPfade = [
  '/api',
  '/getConfig',
  '/setConfig',
  '/reboot',
  '/formatspiffs',
  '/downloadcsv',
  '/download',
  '/deletecsv',
];

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // ECharts ist der mit Abstand größte Brocken — als eigener Chunk
          // bleibt er über UI-Updates hinweg im Browser-Cache.
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
        },
      },
    },
  },
  server: {
    proxy: Object.fromEntries(
      backendPfade.map((p) => [p, { target: core, changeOrigin: true }]),
    ),
  },
});

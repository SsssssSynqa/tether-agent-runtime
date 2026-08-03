// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [viteSingleFile()],
  server: {
    host: '127.0.0.1',
    port: 5187,
    proxy: { '/api': 'http://127.0.0.1:8431' },
  },
  build: { target: 'es2020' },
})

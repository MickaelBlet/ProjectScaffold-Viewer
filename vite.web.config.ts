// Browser build: a single self-contained HTML file (dist-web/index.html) that works
// from file:// or any static host. The renderer uses webApi.ts instead of the preload API.
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Inline the JS bundle and stylesheet into index.html. */
function singleFile(): Plugin {
  return {
    name: 'single-file',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = bundle['index.html']
      if (!html || html.type !== 'asset') return
      let source = String(html.source)
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && file.isEntry) {
          const code = file.code.replace(/<\/script/gi, '<\\/script')
          source = source.replace(
            new RegExp(`<script[^>]*src="[^"]*${name}"[^>]*></script>`),
            () => `<script type="module">${code}</script>`
          )
          delete bundle[name]
        } else if (file.type === 'asset' && name.endsWith('.css')) {
          source = source.replace(
            new RegExp(`<link[^>]*href="[^"]*${name}"[^>]*>`),
            () => `<style>${String(file.source)}</style>`
          )
          delete bundle[name]
        }
      }
      // Inline scripts need 'unsafe-inline'; the page still loads nothing external.
      html.source = source.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    }
  }
}

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  plugins: [react(), singleFile()],
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
})

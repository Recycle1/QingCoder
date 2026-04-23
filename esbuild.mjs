import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';

const watch = process.argv.includes('--watch');

const extensionCtx = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  format: 'cjs',
  minify: false,
};

const webviewCtx = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  format: 'iife',
  minify: false,
};

async function copyMedia() {
  const dir = path.join('media');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function run() {
  await copyMedia();
  const ext = await esbuild.context(extensionCtx);
  const web = await esbuild.context(webviewCtx);
  if (watch) {
    await Promise.all([ext.watch(), web.watch()]);
    console.log('watching...');
  } else {
    await ext.rebuild();
    await web.rebuild();
    await ext.dispose();
    await web.dispose();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

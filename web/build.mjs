/**
 * 把 src/ 下的模板、样式、核心库、界面逻辑拼装成单文件 index.html
 * 用法: node build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const tpl = read('src/template.html');
const css = read('src/style.css');
const core = read('src/core.js');
const stego = read('src/stego.js');
const app = read('src/app.js');

for (const [name, src] of [['core.js', core], ['stego.js', stego], ['app.js', app]]) {
  if (src.includes('</script')) throw new Error(`${name} 含有 </script，会截断 HTML`);
}

function render(extra) {
  let out = tpl
    .replace('/*__CSS__*/', () => css)
    .replace('/*__CORE__*/', () => core)
    .replace('/*__STEGO__*/', () => stego)
    .replace('/*__APP__*/', () => app);
  if (extra) out = out.replace('</body>', () => '<script>\n' + extra + '\n</script>\n</body>');
  const m = out.match(/\/\*__\w+__\*\//);
  if (m) throw new Error('占位符未全部替换: ' + m[0]);
  return out;
}

const out = render(null);
fs.writeFileSync(path.join(root, 'index.html'), out, 'utf8');
console.log('index.html 已生成:', (Buffer.byteLength(out) / 1024).toFixed(1), 'KB');

const selftest = read('src/selftest.js');
const testOut = render(selftest);
fs.writeFileSync(path.join(root, 'test', 'selftest.html'), testOut, 'utf8');
console.log('test/selftest.html 已生成:', (Buffer.byteLength(testOut) / 1024).toFixed(1), 'KB');

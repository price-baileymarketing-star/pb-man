// Recompiles src/game.jsx into index.html. Run from the repository root:
//   npm install @babel/core @babel/preset-react
//   node src/compile.mjs
// Only needed after editing src/game.jsx. The published site never runs Babel.
import { transformSync } from '@babel/core';
import fs from 'fs';

const jsx = fs.readFileSync('src/game.jsx', 'utf8');
const { code } = transformSync(jsx, {
  presets: [['@babel/preset-react', { runtime: 'classic', development: false }]],
  configFile: false, babelrc: false, compact: false, comments: true,
});

const html = fs.readFileSync('index.html', 'utf8');
const marker = '<!-- Compiled from src/game.jsx.';
const start = html.indexOf(marker);
if (start < 0) throw new Error('Marker comment not found in index.html');
const open = html.indexOf('<script>\n', start);
const close = html.indexOf('\n</script>', open);
if (open < 0 || close < 0) throw new Error('Game script block not found in index.html');
fs.writeFileSync('index.html', html.slice(0, open + '<script>\n'.length) + code + html.slice(close));
console.log('index.html updated from src/game.jsx');

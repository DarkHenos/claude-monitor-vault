'use strict';
// Build-time only. The shipped extension has no native or npm dependency.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'media/logo-companion.svg'), 'utf8');
for (const [file, width] of [['icon.png', 256], ['media/logo.png', 512], ['media/logo-128.png', 128]]) {
  fs.writeFileSync(path.join(root, file), new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
}
console.log('Rendered logo at 128, 256 and 512 pixels.');

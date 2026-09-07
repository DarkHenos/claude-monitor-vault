'use strict';
const fs = require('fs'), path = require('path');
const logo = fs.readFileSync(path.join(__dirname, '../media/logo-companion.svg'), 'utf8');
module.exports = { logo };

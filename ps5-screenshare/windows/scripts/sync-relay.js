/* Copia relay/server.js (o servidor de encontro) para src/relay-server.js.
 * O app empacotado nao inclui a pasta relay/, entao o servidor vai junto como
 * copia exata. tests/relayhost.test.js falha se a copia ficar diferente.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', '..', 'relay', 'server.js');
const DST = path.resolve(__dirname, '..', 'src', 'relay-server.js');

function sync() {
  fs.copyFileSync(SRC, DST);
  return DST;
}

if (require.main === module) console.log('copiado: ' + sync());
module.exports = { sync, SRC, DST };

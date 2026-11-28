# Protocolo do relay e da sessão selada

Esta é a especificação usada pelo payload (C), pelo app Windows (JavaScript),
pelo app Android (Java) e pelo próprio relay (Node.js). Os valores de teste estão
em `test/vectors.json`, gerados por `test/gen-vectors.js` com o módulo `crypto`
do Node.

## 1. Pareamento

O PS5 cria um **código de pareamento** de 16 bytes aleatórios. Ele aparece na
página do PS5 (`http://IP-DO-PS5:9700/`, só na rede de casa) como 32 caracteres
hexadecimais em grupos de 4, separados por `-`. Quem tiver o código pode ver e
controlar o PS5, então ele não deve ser publicado.

Derivações (SHA-256 de bytes concatenados, `||` é concatenação):

| Valor | Cálculo |
|---|---|
| `id` | primeiros 16 caracteres hex de `SHA-256("ps5ss-id-v1" \|\| segredo)` |
| `chave` | `SHA-256("ps5ss-key-v1" \|\| segredo)` (32 bytes) |
| `chave_sessão` | `SHA-256("ps5ss-sess-v1" \|\| chave \|\| salt)` (32 bytes) |

O relay só conhece o `id`. Ele não consegue derivar a chave.

## 2. Relay (linhas de texto, TCP)

O relay aceita conexões na porta 9800 (padrão). Cada conexão começa com uma
linha terminada em `\n`:

| Quem envia | Linha | Resposta do relay |
|---|---|---|
| PS5, conexão de registro | `PUB <id>` | `OK`. Depois o relay manda `OPEN <sid>` quando um app quer conectar |
| PS5, conexão nova para um app | `DATA <sid>` | nada. A conexão vira um túnel para o app |
| App | `SUB <id>` | `OK` quando o túnel está pronto; ou `NOCONSOLE`, `BUSY`, `TIMEOUT`, `BADSID`, `BADREQUEST` |
| PS5 | `PING` | (a cada 20 s, para o relay saber que ele está vivo) |

`sid` tem 16 caracteres hex e é escolhido pelo relay. Um PS5 sem `PING` por 60 s
é desconectado. Até 4 apps podem estar conectados ao mesmo PS5 ao mesmo tempo.

Depois de `OK` (para o app) ou de `DATA` (para o PS5), o relay apenas repassa os
bytes nos dois sentidos.

## 3. Sessão selada (depois do relay)

1. O PS5 envia **em texto puro**: `SALT <32 hex>\n` (16 bytes aleatórios por sessão).
2. Os dois lados calculam `chave_sessão` com esse `salt`.
3. O app envia o primeiro quadro (direção `C`, seq 0): `HELLO 1 ...` (texto, sem `\n`).
4. O PS5 responde com o primeiro quadro (direção `S`, seq 0): o cabeçalho de
   stream `PS5S` + `00 01 00 00` (8 bytes). Como só o dono da chave consegue
   produzir esse quadro, o app fica sabendo que o PS5 tem o código.
5. Daí em diante, cada pacote do protocolo normal (cabeçalho de 16 bytes mais
   payload, como no LAN) é um quadro `S`. Cada comando (`KEY`, `PAD ...`,
   `PING ...`, `SET ...`) é um quadro `C`, sem `\n`.

**Quadro:** `u32 big-endian L` seguido de `L` bytes. Os `L` bytes são
`ciphertext || tag`, onde `ciphertext||tag = ChaCha20-Poly1305(chave_sessão, nonce, plaintext)`
(RFC 8439, sem dados adicionais). O plaintext tem no máximo 8 MiB.

**Nonce (12 bytes):** `direção (1 byte) || 00 00 00 || seq (u64 big-endian)`.
A direção é `0x43` (`'C'`) para app → PS5, e `0x53` (`'S'`) para PS5 → app.
Cada direção começa em `seq = 0` e aumenta de 1 em 1 a cada quadro.

Um quadro fora de ordem, repetido, cortado ou alterado não abre (falha na tag) e
a conexão é fechada. Por isso o relay não consegue inserir, apagar nem alterar
nada sem que o outro lado perceba.

## 4. Testes de conformidade

- `test/vectors.json`: pareamento, chave de sessão e quadros para várias entradas.
- O payload (`payload/tests/test_secure.c`) e o app Android
  (`SecureVectors.java`) comparam com esses valores.
- `windows/tests/secure.test.js` compara o app Windows com os mesmos valores.

# PS5 Screen Share - relay (acesso de fora de casa)

Um servidor pequeno que encaminha a conexão entre o PS5 e os apps, para que você
assista e controle o PS5 de outra rede **sem VPN e sem abrir porta no roteador**.

O PS5 e os apps se conectam a este servidor por saída, o que o roteador de casa
e o de qualquer outro lugar deixam passar. O servidor só repassa bytes: a conexão
é criptografada de ponta a ponta com o código de pareamento do PS5 (veja
`PROTOCOL.md`). Quem roda o servidor não consegue ver a tela nem enviar comandos.

## O que você precisa

- Um servidor com **endereço público** (IP fixo ou DNS). Um VPS pequeno basta,
  pois ele só repassa cerca de 8 Mbps por sessão ativa. Qualquer máquina com
  Node.js 18+ serve.
- Liberar a porta TCP **9800** no firewall do servidor (ou outra que você escolher).
- Node.js 18 ou mais novo.

Este repositório não cria esse servidor por você. Se você não tiver um, pode
alugar um VPS e seguir os passos abaixo.

## Rodar

```sh
node server.js            # porta 9800
PORT=9900 node server.js  # outra porta
node server.js 9900       # ou pelo argumento
```

Como serviço (Linux com systemd), `/etc/systemd/system/ps5ss-relay.service`:

```ini
[Unit]
Description=PS5 Screen Share relay
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/ps5ss-relay/server.js 9800
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

Depois: `systemctl enable --now ps5ss-relay`.

## Configurar o PS5

Em `/data/ps5-screenshare/config.ini` no PS5 (por FTP), adicione:

```ini
relay=seu.servidor.com:9800
```

Reinicie o payload. Na página `http://IP-DO-PS5:9700/` (só na rede de casa), o
**código de pareamento** aparece. Ele é usado nos apps uma vez.

## Configurar os apps

No app Windows ou Android, escolha **Pela internet**, informe o servidor, a porta
e o código de pareamento. Isso fica salvo no aparelho.

## Segurança

- O código de pareamento é a chave. Quem tiver o código pode ver e controlar o PS5.
  Não o publique, e troque-o apagando `/data/ps5-screenshare/pairing.txt` no PS5
  (um novo código é criado na próxima inicialização).
- O relay não guarda nada além de quais IDs estão conectados, e só enquanto estão.
- O tráfego é criptografado de ponta a ponta. Mesmo assim, o relay vê **quando**
  há uma sessão e quanto tráfego passa.

## Testes

```sh
npm test
```

Testa o pareamento, o encaminhamento nos dois sentidos, os erros (sem PS5,
tempo esgotado, limite de apps, identificador inválido) e a substituição de um
PS5 registrado.

# PS5 Screen Share para Windows

Veja a tela do PS5 no PC e jogue com o teclado, como no Remote Play.

- Vídeo H.264 por hardware (WebCodecs, dentro do Chromium do Electron) e áudio.
- Controle pelo teclado: cada botão do PS5 é uma tecla que você escolhe.
- Conexão pela rede de casa, ou de fora de casa pelo seu PC (servidor de acesso) ou por VPN.
- Precisa do payload `ps5-screenshare.elf` rodando no PS5 (pasta `payload/`).

Requisitos: Windows 10 ou 11 de 64 bits.

## Usar

1. No PS5, envie `ps5-screenshare.elf` para a porta 9021 do console (como no README principal).
2. Abra o **PS5 Screen Share** no PC.
3. Na mesma rede, clique em **Procurar na rede** e escolha o console. Ou digite o endereço
   (ex.: `192.168.0.10`) e clique em **Conectar**.
4. Com a transmissão aberta, o teclado já controla o PS5. Se as teclas não responderem, clique na janela.

### Teclas padrão

| Botão do PS5 | Tecla | Botão do PS5 | Tecla |
|---|---|---|---|
| Direcional | Setas | Analógico esquerdo | W A S D |
| Cruz (×) | X | Analógico direito | I J K L |
| Círculo (○) | C | L1 / R1 | Q / E |
| Quadrado (□) | Z | L2 / R2 | 1 / 3 |
| Triângulo (△) | V | L3 / R3 | F / G |
| Options | Enter | PS / Touchpad | Home / T |

Para mudar: **Teclas…** (na tela de conexão ou durante a transmissão). Clique num botão,
pressione a tecla nova. Se a tecla já for de outro botão, os dois trocam de lugar. Esc cancela,
Delete apaga. **Salvar** guarda a escolha. As teclas são pela posição física, então funcionam
igual em teclados ABNT2 e US.

Outras teclas durante a transmissão: **F11** tela cheia. Ao trocar de janela, todas as teclas
são soltas no console, para nada ficar "preso".

## Acesso de fora de casa (este PC como servidor)

Não precisa de servidor pago nem de abrir porta no roteador. Este PC faz o papel do servidor de
acesso, e o Tailscale (gratuito) leva o caminho até ele de fora.

1. **Tailscale:** instale no PC e no aparelho de fora (celular ou outro PC), com a mesma conta.
   É instalação única; depois ele fica ligado sozinho.
2. **PS5:** pelo FTP, no arquivo `/data/ps5-screenshare/config.ini`, deixe a linha
   `relay=IP-DESTE-PC:9800` (o IP da rede de casa aparece no menu, em **Ver endereços**).
   Depois envie o `ps5-screenshare.elf` de novo.
3. **Este PC:** no menu **Acesso de fora de casa**, marque **Hospedar acesso neste PC**. O app
   passa a aceitar conexões na porta 9800 e lembra a escolha ao abrir. Na primeira vez, o Windows
   pode pedir para liberar o app no firewall: permita.
4. **De fora:** no app do PC ou no APK, escolha **Pela internet**, informe o endereço **100.x** deste
   PC (menu **Ver endereços**) e a porta 9800, e o código de pareamento da página `http://IP-do-PS5:9700`.

Pontos de atenção:
- Este PC precisa estar ligado, com o app aberto, e o PS5 com o payload rodando.
- O servidor só repassa bytes: não vê a imagem nem os comandos (a conexão é criptografada com o código).
- O IP de casa pode mudar; se mudar, o `relay=` do PS5 precisa ser atualizado. Reserve um IP fixo
  para este PC no roteador, se puder.
- De fora, use 720p a 5 Mbps: o envio da internet de casa costuma ser o limite.

## Conectar de fora de casa

### Pela internet (servidor de acesso)

Escolha **Pela internet** na tela de conexão, informe o endereço do servidor de acesso (porta
9800) e o código de pareamento (está na página `http://IP-do-PS5:9700`, quando você está na
sua rede). O código fica salvo neste PC; quem tiver o código pode ver e controlar o PS5, então não
o compartilhe. A conexão é criptografada de ponta a ponta. Veja [`../relay/README.md`](../relay/README.md).

### Por VPN (alternativa)

Não é preciso abrir a porta do PS5 na internet. Uma VPN que leve até a sua rede também funciona:
o PC entra na rede de casa e o endereço do PS5 é o mesmo de dentro. Use **Rede de casa** com o
endereço do PS5. Não exponha a porta 9700 do PS5 diretamente na internet: o modo de rede local
não tem criptografia.

Duas formas comuns de VPN:

- **WireGuard no roteador.** Alguns roteadores (ex.: GL.iNet, UniFi, ASUS) têm servidor WireGuard
  ou OpenVPN na própria configuração. Crie um cliente para o PC e conecte antes de abrir o app.
- **Tailscale.** Instale no PC e em um aparelho sempre ligado na sua rede (um PC, um Raspberry Pi,
  ou o próprio roteador se ele suportar), com a opção de rota para a sua rede local (subnet router).
  Depois use o endereço do PS5 normalmente.

Em qualquer dos dois caminhos, a imagem depende da internet de casa (ou do servidor) para chegar
ao PC. Para jogar de fora, comece com **720p a 5 Mbps** (já vem selecionado ao escolher 720p).

O app mostra um aviso no modo **Rede de casa** se o endereço digitado não parecer ser da sua rede
ou de uma VPN.

## Se algo não funcionar

- **Nenhum console aparece:** a busca usa broadcast, que não atravessa VPN nem roteadores. Digite o
  endereço. Confira também se o Windows liberou o app no firewall (primeira execução: "Redes
  privadas").
- **Tela preta, mas conectado:** atualize o driver da placa de vídeo. Veja as estatísticas
  (botão **Estatísticas**): se "erros de decodificação" subir, o problema é o decodificador.
- **Sem som:** confira o botão **Som** e se "Ouvir o áudio do PS5" estava marcado ao conectar.
- **"Controle indisponível":** o payload não conseguiu criar o controle virtual no console (veja
  `http://IP-DO-PS5:9700/log`). A transmissão continua funcionando.
- **"Controle em uso por outro aparelho":** só um aparelho controla por vez (o celular ou outro PC).
- **Windows mostra "O Windows protegeu o seu PC":** o app não é assinado digitalmente. Clique em
  "Mais informações" e depois em "Executar assim mesmo".

As configurações ficam em `%APPDATA%\PS5 Screen Share\settings.json`.

## Gerar o aplicativo (para quem for compilar)

No Windows, com [Node.js](https://nodejs.org) LTS instalado, na pasta `windows`:

```
npm install
npm run dist
```

O resultado fica em `dist\PS5 Screen Share-win32-x64\PS5 Screen Share.exe`. A pasta inteira é o
app (é portátil; não precisa instalar). O Electron baixa o runtime de Windows automaticamente. O
ZIP dessa pasta fica em torno de 160 MB, por causa do Chromium.

Também dá para gerar a partir do Linux (`npm run dist`), porque o Electron baixa a versão de
Windows de qualquer lugar.

## Testes

```
npm test                 # unitários: protocolo, teclas, configurações, conexão, busca
npm run test:e2e         # app de verdade contra o payload (precisa do build host do payload)
npm run test:e2e:remote  # o app hospeda o servidor de acesso quando ligado (remote.json)
```

O teste de ponta a ponta sobe o app Electron, conecta num payload de teste (`make host` em
`payload/`, com captura simulada), confere que a imagem chega ao canvas, que teclas seguradas
chegam ao console e que uma tecla trocada passa a valer. No Linux, rode com `xvfb-run`.

## Estrutura

```
main.js            processo principal: janela, conexão TCP, busca, configurações
preload.js         ponte segura entre a página e o processo principal
src/protocol.js    protocolo (pacotes, linha PAD, codec H.264, endereços privados)
src/bindings.js    teclas → botões do PS5 (e trocas de teclas)
src/stream.js      conexão com o PS5 (tempo limite, eventos)
src/discovery.js   busca de consoles por broadcast
src/settings.js    configurações salvas
renderer/          tela: conexão, vídeo (video.js), áudio (audio.js), teclas e telas (app.js)
src/relay-host.js servidor de acesso dentro do app (ligado pelo menu)
src/relay-server.js cópia de relay/server.js (gerada por scripts/sync-relay.js)
scripts/package.js gera o app e o ZIP para Windows
tests/             testes unitários e de ponta a ponta
```

## Licença

GPL-3.0-or-later. O Electron e o Chromium têm as próprias licenças (incluídas no app).

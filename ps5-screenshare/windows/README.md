# PS5 Screen Share para Windows

Veja a tela do PS5 no PC e jogue com o teclado, como no Remote Play.

- Vídeo H.264 por hardware (WebCodecs, dentro do Chromium do Electron) e áudio.
- Controle pelo teclado: cada botão do PS5 é uma tecla que você escolhe.
- Conexão pela rede de casa, ou de fora de casa por VPN (veja abaixo).
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

## Conectar de fora de casa (VPN)

O PS5 não tem senha nem criptografia. Por isso o app **não** deve ser usado com a porta do PS5
aberta na internet: quem achar o endereço poderia ver a tela e controlar o console. Para acessar
de fora, o caminho é uma VPN que leve até a sua rede. Assim o PC entra na rede de casa de forma
criptografada, e o endereço do PS5 é o mesmo de dentro de casa.

Duas formas comuns:

- **WireGuard no roteador.** Alguns roteadores (ex.: GL.iNet, UniFi, ASUS) têm servidor WireGuard
  ou OpenVPN na própria configuração. Crie um cliente para o PC e conecte antes de abrir o app.
- **Tailscale.** Instale no PC e em um aparelho sempre ligado na sua rede (um PC, um Raspberry Pi,
  ou o próprio roteador se ele suportar), com a opção de rota para a sua rede local (subnet router).
  Depois use o endereço do PS5 normalmente.

Com VPN, a imagem depende da internet de casa para enviar o vídeo. Para jogar de fora, comece
com **720p a 5 Mbps** (já vem selecionado ao escolher 720p).

O app mostra um aviso se o endereço digitado não parecer ser da sua rede ou de uma VPN.

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
scripts/package.js gera o app para Windows
tests/             testes unitários e de ponta a ponta
```

## Licença

GPL-3.0-or-later. O Electron e o Chromium têm as próprias licenças (incluídas no app).

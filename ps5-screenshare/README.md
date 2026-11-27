# PS5 Screen Share

Espelha a tela do PS5 (com áudio) num celular Android pela rede Wi-Fi local.

- **`dist/ps5-screenshare.elf`**: payload homebrew para PS5 desbloqueado (ELF loader).
- **`dist/ps5-screenshare.apk`**: app Android (Android 5.0 ou mais novo, 37 KB).

O payload usa o **encoder H.264 por hardware do próprio PS5**: é o mesmo
serviço de captura (`libSceAvcap2`) que o console usa no Share e no Remote
Play. O vídeo já sai comprimido do console e o celular decodifica por hardware
(MediaCodec). Por isso a CPU quase não é usada e a latência fica baixa.

> **Importante:** não pude testar num PS5 de verdade. O servidor, o protocolo,
> o supervisor e o app foram testados de ponta a ponta no Linux com uma captura
> simulada (veja [Testes](#testes)). A parte que só roda no console, a abertura
> da captura, foi adaptada de projetos que funcionam em console
> ([créditos](#créditos)). Ainda assim, ela é o ponto mais provável de
> precisar de ajuste no seu firmware. Se algo falhar, abra
> `http://IP-DO-PS5:9700/log` e me mande o conteúdo.

> Se você **não** tem jailbreak, use o app oficial **PS Remote Play** (Android),
> que faz isso oficialmente e também permite jogar pelo celular.

## Como usar

1. No PS5 desbloqueado, carregue o seu ELF loader (por exemplo,
   [ps5-payload-elfldr](https://github.com/ps5-payload-dev/elfldr), que escuta
   na porta 9021).
2. Envie `dist/ps5-screenshare.elf` para a porta **9021** do console. Use a
   ferramenta que você já usa para payloads, ou:
   ```sh
   python3 payload/tools/deploy.py 192.168.0.10 dist/ps5-screenshare.elf
   # ou: socat -u FILE:dist/ps5-screenshare.elf TCP:192.168.0.10:9021
   ```
3. O PS5 mostra a notificação **"PS5 Screen Share pronto em IP:9700"**.
4. Instale o app no celular. O jeito mais fácil é abrir
   `http://IP-DO-PS5:9700/` no navegador do celular e tocar em
   **Baixar o app Android**, porque o APK vem embutido no payload. Também dá
   para copiar `dist/ps5-screenshare.apk` para o celular. O Android vai pedir
   para permitir a instalação de apps de fontes desconhecidas.
5. Abra o app na mesma rede Wi-Fi. O PS5 aparece sozinho na lista; toque nele.
   Se ele não aparecer, digite o IP.

Durante a transmissão, os **controles do PS5 aparecem sobre a imagem**, como no
Remote Play. Toque nos botões para jogar. Toque em outro ponto da tela para
mostrar ou esconder a barra com **áudio**, **ajustar/esticar**, **qualidade**
(720p até 4K, de 5 a 32 Mbps) e o botão **Controle** (liga e desliga os
controles na tela).

Dicas:
- Use Wi-Fi de **5 GHz**. 1080p60 a 8 Mbps é o padrão. Se travar, troque para
  720p.
- Até 4 celulares podem assistir ao mesmo tempo. A qualidade vale para todos.
- Enviar o ELF de novo substitui a cópia que está rodando.
- Quando um jogo abre ou fecha, o PS5 muda o modo de vídeo e a captura cai. O
  payload reinicia a captura sozinho num processo novo (via ELF loader). A
  imagem volta em cerca de 10 segundos e o app reconecta sozinho.
- A captura só fica ligada enquanto há alguém assistindo (e mais 15 segundos).

## Controle pelo celular

Os botões na tela seguem o layout do DualSense: **direcional** e **quatro
botões de ação** (△ ○ × □) à direita, **analógicos** embaixo, **L1/L2/R1/R2**
em cima, e **PS**, **OPTIONS** e **TOUCH** no centro. Ao tocar num botão, ele é
enviado ao console na hora. Os analógicos funcionam arrastando o dedo.

- **Um celular controla por vez.** O primeiro que toca num botão assume o
  controle. Os outros veem "Controle em uso por outro celular".
- **Quem controla precisa continuar tocando ou mantendo o dedo.** Se o celular
  ficar sem enviar nada por 2 segundos, o controle é liberado, e o console volta
  ao estado neutro após 250 ms sem entrada.
- **Desconectar o celular libera o controle na hora.**

O controle usa o mesmo caminho de *controle virtual* do PBS-Payload (GPL-3.0),
o que mantém o PS5 reconhecendo o pad como um controle real.

> **Atenção:** o servidor não tem senha. Quem estiver na mesma rede Wi-Fi pode
> enviar comandos ao PS5, então use em rede de confiança. Para desligar o
> controle e deixar só a transmissão, use `pad=0` em `config.ini`.

**Não verificado num console:** a entrada do controle virtual, e os bits de
OPTIONS, PS e TOUCH (copiados da tabela do PBS-Payload). Se algum botão fizer
outra coisa, me diga qual e veja `http://IP-DO-PS5:9700/log` (linhas que
começam com `pad:`).

## Firmware

A captura é aberta com uma estrutura de parâmetros cujo tamanho e layout mudam
conforme o firmware. O payload detecta a versão e escolhe o layout medido para
ela:

| Firmware | Situação |
|---|---|
| 11.20 a 13.20 | Registro idêntico (testado byte a byte) ao do ps5-web-stream, validado em console |
| 3.20 a 10.60, 13.42, 13.60 | Layout medido pelo PBS-Payload a partir de dumps de cada firmware (*experimental*) |
| Demais versões | Usa o perfil medido mais próximo (*experimental*) |

Se a captura for recusada como inválida, o payload tenta sozinho as outras
variantes do registro e grava no log qual delas funcionou.

## Configuração opcional

Crie `/data/ps5-screenshare/config.ini` no PS5 (por FTP, por exemplo):

```ini
port=9700           ; porta TCP do stream/HTTP e UDP da descoberta
resolution=1080p    ; 720p | 1080p | 1440p | 2160p
fps=60              ; 30 | 60
bitrate=8000        ; kbit/s
audio=1             ; capturar o áudio do sistema
variant=auto        ; auto | pws | native | synthetic (registro do OpenVideo)
resource_1080=0xb4  ; IDs do ResourceArbitrator (avançado)
resource_4k=0xb6
idle_timeout=15     ; segundos capturando depois que o último celular sai
notify=1            ; notificações no PS5
pad=1               ; deixar os celulares controlarem o PS5 (0 desliga)
```

Os logs ficam em `/data/ps5-screenshare/log.txt` e em
`http://IP-DO-PS5:9700/log`. O estado em JSON fica em `/status`.

## Assistir no PC (opcional)

```sh
python3 payload/tools/ps5ss_client.py --discover
python3 payload/tools/ps5ss_client.py 192.168.0.10 | ffplay -fflags nobuffer -f h264 -
```

## Como funciona

```
PS5 (payload)                                           Android (app)
─────────────                                           ─────────────
libSceAvcap2  ──H.264 por hardware──┐                  StreamClient (TCP)
(saída HDMI composta)               │                    ├─ vídeo → MediaCodec → SurfaceView
libSceAvcap2  ──PCM 48 kHz──────────┼─► servidor TCP ──►─┤
(mix do sistema)                    │    :9700           └─ áudio → AudioTrack (baixa latência)
ResourceArbitrator (reserva)        │
                                    └─ HTTP :9700 (/ /status /log /app.apk)
descoberta UDP :9700  ◄──── "PS5SS?" (broadcast) ──── app
supervisor ── reinicia o serviço via ELF loader quando o modo de vídeo muda
```

O protocolo está descrito em [`payload/src/protocol.h`](payload/src/protocol.h).
Resumo: cabeçalho de 8 bytes e depois pacotes `tipo, flags, tamanho, pts` com
INFO (JSON), VIDEO (H.264 Annex-B com SPS/PPS em todo IDR), AUDIO (PCM s16le
estéreo) e STATUS. Cada celular tem uma fila própria. Um celular lento não
atrasa os outros: se ele ficar mais de 1,5 s para trás, a fila dele é
descartada e ele volta no próximo quadro-chave.

## Compilar

Payload (precisa do [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk),
clang/lld 18):

```sh
export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk
make -C payload APK=../dist/ps5-screenshare.apk   # APK opcional, servido em /app.apk
# gera payload/build/ps5-screenshare.elf (supervisor + serviço embutido)
#   e payload/build/ps5-screenshare-service.elf (serviço sozinho, sem auto-reinício)
```

App (JDK 17+, Android SDK 34):

```sh
cd android && ./gradlew assembleRelease   # app/build/outputs/apk/release/app-release.apk
```

O APK de `dist/` é assinado com uma chave de depuração. Para instalar uma
versão assinada com outra chave, desinstale a anterior antes.

## Testes

Feitos no Linux (sem PS5):

- `make -C payload test` também cobre o controle: validação do formato da linha
  `PAD`, dono único, release por desconexão, por `PADRELEASE` e por 2 s de
  silêncio, linhas malformadas ignoradas, e `pad=0` / `PS5SS_MOCK_PAD=0`.

- `make -C payload test`: compila o serviço para Linux com AddressSanitizer e
  UBSan e uma captura simulada (reproduz um arquivo H.264 e gera um tom de
  440 Hz). Testa HTTP, descoberta UDP, streaming (o vídeo recebido é
  decodificado sem erros pelo ffmpeg, ~60 fps), áudio, PING, dois clientes,
  ressincronização de cliente lento, troca de qualidade, limite de clientes,
  entrada inválida, falha de abertura com troca de variante, perda de sessão,
  pedido de reinício ao supervisor, QUIT e substituição de cópia. Testa também
  o supervisor de ponta a ponta com um ELF loader falso e compara os registros
  do OpenVideo com a referência.
- `cd android && ./gradlew testDebugUnitTest`: testes do protocolo e do H.264.
  Com `PS5SS_TEST_HOST`/`PS5SS_TEST_PORT` apontando para o serviço, também roda
  a tela de transmissão (Robolectric) contra o servidor real: conecta, recebe e
  decodifica (~60 fps) e mostra as estatísticas.

O que **não** foi testado: a abertura real da captura num PS5, a entrada do
controle virtual num console, a decodificação num celular físico e a latência
ponta a ponta. Os testes de controle no Android (layout e toque) rodam no JVM,
sem tela.

## Créditos

- [ps5-web-stream](https://github.com/heydemoura/ps5-web-stream) (heydemoura,
  GPL-3.0+): sequência de captura `libSceAvcap2`/ResourceArbitrator, registro
  de 0x2e0 bytes, cabeçalhos SPS/PPS, relógio, áudio e a ideia do supervisor.
- [PBS-Payload](https://github.com/the-mentor/PBS-Payload) (GPL-3.0+): layouts
  do pedido de captura medidos por firmware (`payload/src/fwprofiles_data.c`,
  gerado por `payload/tools/gen_fwprofiles.py`).
- [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk) (John Törnblom).

Nenhum código da Sony está incluído. As bibliotecas do firmware são carregadas
em tempo de execução. Use apenas no seu próprio console. Licença: GPL-3.0 ou
posterior.

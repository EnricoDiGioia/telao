# Telão

Transmissão de tela e câmera entre amigos, direto no navegador, para usar junto com o Discord (a voz continua no Discord; o Telão cuida do vídeo).

- Transmitir a tela (com o áudio dela) e a câmera ao mesmo tempo
- Qualidade ajustável na hora: resolução (720p até Original), fps (15/30/60), taxa de bits e prioridade (fluidez ou nitidez)
- **Destacar**: abre o vídeo numa janela separada que você arrasta para qualquer lugar ou outro monitor e redimensiona
- **Flutuar**: janela pequena que fica sempre por cima de tudo, como o picture-in-picture
- Foco (duplo clique num vídeo), tela cheia, volume por transmissão e um indicador com resolução, fps e Mbps reais que está chegando

## Como funciona

O site fica hospedado de graça na Cloudflare, num endereço tipo `https://telao.seu-nome.workers.dev`. Ele fica no ar o tempo todo, então qualquer amigo abre o link e cria ou entra numa sala quando quiser, mesmo com o seu PC desligado.

O vídeo não passa pela Cloudflare: vai direto de um computador para o outro (WebRTC). A Cloudflare só apresenta as pessoas da sala umas às outras, o que gasta muito pouco do plano gratuito (100 mil requisições por dia).

## Publicar (uma vez só)

Você precisa do [Node.js](https://nodejs.org) 18+ e de uma conta grátis na [Cloudflare](https://dash.cloudflare.com/sign-up). Não precisa cartão.

**No Windows:** dê dois cliques em `publicar.bat`. Na primeira vez ele abre o navegador para você entrar na conta Cloudflare e autorizar. Se perguntar sobre registrar um subdomínio `workers.dev`, aceite e escolha um nome (ele vira parte do endereço).

**Em outro sistema:**

```bash
npm install
npx wrangler login
npx wrangler deploy
```

No final aparece o endereço do Telão. Esse é o link que você manda para os amigos. Para atualizar depois de mudar algo no código, é só rodar `publicar.bat` de novo; o endereço continua o mesmo.

**Publicação automática:** o Worker `telao` está ligado a este repositório do GitHub (Cloudflare → Workers & Pages → telao → Settings → Builds). Cada mudança enviada para a branch `main` publica o site sozinha em 1 ou 2 minutos, sem precisar do `publicar.bat`.

Endereço atual: https://telao.ricodigioia.workers.dev

Se quiser que outra pessoa também possa publicar atualizações, adicione ela como membro na sua conta Cloudflare (Manage Account → Members), ou coloque o projeto no GitHub e conecte o repositório ao Worker no painel da Cloudflare (Workers & Pages → telao → Settings → Builds), assim cada push publica sozinho.

## Como usar

1. Abra o endereço, escolha um nome e uma sala (ou deixe a sugerida).
2. Clique em **Copiar convite** e mande o link no Discord. Quem abrir entra na mesma sala.
3. **Câmera** e **Transmitir tela** ligam e desligam cada coisa.
4. **Qualidade** abre o painel. Tudo muda ao vivo, menos "Transmitir o áudio da tela", que vale a partir da próxima transmissão.
5. Passe o mouse num vídeo para ver os botões: focar, destacar, flutuar, tela cheia e volume.

Quando alguém começa a transmitir a tela, ela vai sozinha para o destaque se nada estiver focado.

Use Chrome ou Edge no computador. Firefox funciona, mas sem a janela "Flutuar" sempre por cima e sem áudio de tela.

### App de Android

O Android não deixa sites transmitirem a tela, então existe um app (pasta `android/`). Ele mostra o mesmo site por dentro e, ao tocar em **Transmitir tela**, transmite a tela do celular pelo próprio app, inclusive em segundo plano (dá para abrir um jogo e continuar transmitindo). Para parar, use o botão no Telão ou a notificação.

- **Baixar:** `https://github.com/EnricoDiGioia/telao/releases/latest/download/telao.apk` (abra pelo celular). O Android vai pedir para permitir instalar apps desta fonte.
- **Atualizar:** baixe e instale o APK novo por cima; não precisa desinstalar.
- **Gerar uma versão nova:** qualquer mudança na pasta `android/` enviada ao GitHub dispara o build sozinho (aba Actions). O APK aparece em Releases em uns 5 minutos.
- **Endereço embutido:** em Settings → Secrets and variables → Actions → Variables, crie `TELAO_URL` com o endereço do Telão (ex.: `https://telao.seunome.workers.dev`). Assim o app já abre direto no Telão; sem isso, ele pede o link na primeira vez.
- Na tela, o app aparece para os outros como "Seu nome (tela)". O áudio do celular ainda não vai junto.

### No celular (navegador)

- **Android:** dá para assistir e transmitir a **câmera**, mas não a tela. O Android não deixa nenhum navegador (Chrome, Samsung Internet, Firefox) capturar a tela para um site. O botão aparece apagado e explica isso ao ser tocado.
- **iPhone/iPad:** câmera em qualquer versão; a tela só no iOS 27 ou mais novo, pelo Safari.
- O botão **Virar** troca entre câmera frontal e traseira sem interromper a transmissão.
- Enquanto transmite, a tela do celular fica acesa sozinha.
- Se você trocar de app ou bloquear a tela, o navegador pausa a câmera e os amigos veem a imagem parada. Ao voltar, a câmera retoma sozinha. A transmissão da tela no iPhone para de vez; ao voltar aparece um botão para transmitir de novo.

Transmitir em segundo plano e a tela do Android só seriam possíveis com um app instalado (não um site).

### Áudio da tela no Windows

Só sai áudio quando você compartilha **uma aba** ou **a tela inteira** com a caixa "Compartilhar áudio" marcada. Compartilhar uma janela específica não leva som (limitação do Chrome/Edge). Atenção: na tela inteira com áudio, o som do Discord também vai junto, e os amigos se escutam com atraso. Se isso acontecer, desmarque o áudio ou compartilhe só a aba.

## Quanto de internet precisa

Cada pessoa conecta direto com cada outra, então quem transmite envia uma cópia para cada amigo. Exemplo: tela em 1080p30 na taxa automática (cerca de 4,5 Mbps) para 3 amigos usa uns 13,5 Mbps de **upload**. Para grupos de até 4 ou 5 pessoas funciona bem; se o upload for fraco, baixe a taxa de bits ou a resolução.

Taxa automática usada para a tela:

| Resolução | 15 fps | 30 fps | 60 fps |
|---|---|---|---|
| 720p | 1,5 Mbps | 2,5 Mbps | 4 Mbps |
| 1080p | 2,7 Mbps | 4,5 Mbps | 7,2 Mbps |
| 1440p / Original | 4,8 Mbps | 8 Mbps | 12,8 Mbps |

## Deixar a transmissão mais fluida

O canto de cada vídeo mostra o que está acontecendo. No seu próprio vídeo aparece algo como `1920×1080 · 60 fps · 6,1 Mbps · H.264 GPU`. Se aparecer em laranja `limite: processador` ou `limite: internet`, é ali que está o gargalo.

- **Codificação** (painel Qualidade → Desempenho): na opção Automática o Telão usa a placa de vídeo quando o navegador informa que ela codifica algum formato (geralmente H.264). Isso tira o peso do processador e é o que mais ajuda em jogos. O seletor mostra quais opções usam placa de vídeo neste PC.
- **`limite: processador`**: escolha um codec marcado "placa de vídeo" ou baixe resolução e fps.
- **`limite: internet`**: baixe a taxa de bits ou a resolução.
- **Quem assiste com engasgos**: no painel de quem assiste, mude Reprodução para "Mais suave". Ele guarda 0,3 s de vídeo para absorver as oscilações da rede.
- **Jogos e vídeos**: deixe Priorizar em "Fluidez". Em "Nitidez" o navegador sacrifica fps para manter o texto legível.
- Os primeiros segundos sempre ficam mais borrados: a conexão começa com pouca taxa e sobe sozinha em uns 5 a 10 s.

Cada amigo assistindo é uma codificação a mais no PC de quem transmite. Com placa de vídeo isso pesa pouco; só pelo processador, de 3 pessoas para cima começa a pesar.

## Quando alguém não consegue conectar (TURN)

Às vezes duas pessoas não conseguem se ligar direto (internet móvel, alguns provedores com CGNAT, redes de faculdade). O app avisa quando isso acontece. A solução é um servidor TURN, que repassa o vídeo quando a conexão direta falha. Há serviços com plano gratuito limitado (por exemplo Metered e Cloudflare Realtime). Com os dados em mãos:

1. Em `wrangler.toml`, tire o `#` das linhas `TURN_URL` e `TURN_USER` e preencha.
2. Rode `npx wrangler secret put TURN_PASS` e cole a senha.
3. Publique de novo.

## Outras configurações

Em `wrangler.toml`, `MAX_PER_ROOM` define o máximo de pessoas por sala (padrão 8).

## Rodar no próprio PC (opcional)

Para testar mudanças antes de publicar: `npx wrangler dev` e abra `http://localhost:8787`.

Também dá para rodar sem Cloudflare com `rodar-local.bat` (ou `npm run local`), que abre em `http://localhost:3000`. Nesse modo o servidor depende do seu PC ligado, como antes.

## Arquivos

- `public/`: o app (index.html, style.css, app.js)
- `worker/index.js`: servidor na Cloudflare (uma sala por Durable Object)
- `wrangler.toml`: configuração da publicação
- `server.js`: servidor alternativo para rodar no PC

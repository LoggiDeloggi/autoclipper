# AutoClipper

Pega um video longo (live, podcast, gravacao), acha os melhores momentos e corta em clips prontos para editar.
Sem legenda e sem mudar o formato: voce edita depois.

Fluxo: ffmpeg extrai o audio -> whisper.cpp transcreve (local, na sua maquina) -> Gemini escolhe e nota os trechos -> ffmpeg corta.
Somente o texto da transcricao vai para o Gemini; o video nunca sai do seu computador.

## Como usar

1. Baixe o app (veja abaixo) e abra.
2. Clique em **Configuracoes** e cole sua chave do Gemini. Ela e gratuita: https://aistudio.google.com/apikey
3. Arraste o video. Os clips saem na pasta `<nome-do-video>_clips`, ao lado do original, ordenados do melhor para o pior.

A chave fica guardada so no seu computador, criptografada pelo sistema (Credenciais do Windows / Keychain do Mac).

Os downloads ficam na pagina de **Releases** do repositorio (lado direito da pagina inicial).

### Windows
Baixe `AutoClipper-<versao>-win-x64.zip`, descompacte a pasta inteira em um caminho **sem acentos** (ex.: `C:\AutoClipper`) e abra `AutoClipper.exe`.
Se o SmartScreen avisar, clique em "Mais informacoes" > "Executar assim mesmo" (o app nao e assinado).
Aceleracao: usa a GPU (Vulkan: NVIDIA, AMD ou Intel) automaticamente e cai para a CPU se falhar.

### Mac
Baixe o zip da sua versao em **Releases**:
- `AutoClipper-<versao>-arm64-mac.zip`: Macs com chip Apple (M1, M2, M3, M4)
- `AutoClipper-<versao>-mac.zip`: Macs Intel

Descompacte e **na primeira vez** abra com botao direito no app > **Abrir** > **Abrir** (o app nao e assinado pela Apple).
Se o Mac disser que o app esta "danificado", rode no Terminal: `xattr -cr /caminho/para/AutoClipper.app`
A transcricao usa a GPU da Apple (Metal).

## Desenvolvimento

```
npm install
npm test        # checagem rapida da logica dos cortes
npm start       # abre o app (precisa do whisper.cpp na pasta ../whisper-vk e do modelo em ../whisper/ggml-small.bin)
npm run dist    # gera a pasta do Windows em dist/win-unpacked
```

O build do Mac e feito pelo GitHub Actions (`.github/workflows/build-mac.yml`): compila o whisper.cpp com Metal, baixa o modelo `small` e empacota.
Para rodar: **Actions > Build macOS > Run workflow**.

## Licencas

O codigo do AutoClipper e licenciado sob a [licenca MIT](LICENSE).

O app empacotado inclui componentes de terceiros, cada um com a sua licenca:
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) e o modelo Whisper (OpenAI): MIT
- [Electron](https://www.electronjs.org/): MIT
- [ffmpeg](https://ffmpeg.org/) (via `ffmpeg-static`): GPL. O AutoClipper o executa como programa separado, sem incorporar o codigo dele. Ao distribuir o app, mantenha este aviso; o codigo-fonte do ffmpeg esta em https://ffmpeg.org/download.html
- Vulkan (somente o runtime do Windows) e os runtimes do Visual C++ redistribuiveis da Microsoft acompanham o build de Windows

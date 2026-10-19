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

### Windows
Descompacte a pasta inteira em um caminho **sem acentos** (ex.: `C:\AutoClipper`) e abra `AutoClipper.exe`.
Se o SmartScreen avisar, clique em "Mais informacoes" > "Executar assim mesmo" (o app nao e assinado).
Aceleracao: usa a GPU (Vulkan: NVIDIA, AMD ou Intel) automaticamente e cai para a CPU se falhar.

### Mac
Baixe o zip da sua versao em **Actions > Build macOS > ultimo run > Artifacts**:
- `AutoClipper-mac-arm64`: Macs com chip Apple (M1, M2, M3, M4)
- `AutoClipper-mac-x64`: Macs Intel

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

whisper.cpp e o modelo Whisper: MIT. ffmpeg (via ffmpeg-static): GPL; se voce distribuir o app, informe isso e ofereca o codigo-fonte do ffmpeg.

# The Final Song — Drakengard 3 (recreazione web)

Online: https://danieleavolio.github.io/dod3-final-song/ — il download automatico della canzone richiede il server locale; online carica il file audio.

La boss fight ritmica finale di **Drakengard 3** (Branch D, "The Final Song")
ricreata come gioco **nativo browser**: 234 note + il chime finale, sette sezioni
(ZERO → FIVE → FOUR → THREE → TWO → ONE → ALL), decelerazione finale a 46 BPM.
Nessun emulatore, nessun server: solo HTML/TypeScript/canvas/WebAudio.

Ricreazione amatoriale non affiliata a Square Enix, Access Games o Sony.
Nessuna traccia musicale è inclusa: si carica dal proprio file. I due effetti
sonori di lancio/rottura sono forniti dall'utente.

## Avvio

Serve Node 20.19+ o 22.12+ (testato con Node 22) e un browser moderno.

```sh
npm install
npm run dev          # http://localhost:5199
```

Build statica (deployabile su GitHub Pages, itch.io o qualsiasi hosting statico):

```sh
npm run build        # rigenera il chart, typecheck, build in dist/
npm run preview      # serve dist/ su http://localhost:5199
```

> Aprire `dist/index.html` con `file://` non funziona: i moduli ES richiedono
> un server HTTP. `npm run preview` o `npx serve dist` bastano.

## Come si gioca

- **Spazio** / **Invio** / **X** / **C** / **V** / **B** per colpire.
- **Qualsiasi pulsante del gamepad** (DualShock/DualSense/Xbox) o clic sullo schermo.
- **Esc** pausa, **R** ricomincia.
- Le note sono anelli che si espandono verso l'anello bersaglio: colpisci quando
  l'anello arriva sul bersaglio. Il fight originale accetta quasi tutti i
  pulsanti: conta solo il tempo (niente sequenze di ✕○□△ da indovinare).

### Modalità

- **Autentica** — da 0:00 al chime finale, finestra ±105 ms, **un errore = game
  over**. È la modalità fedele.
- **Pratica** — nessun game over, finestra ±150 ms, sezione a scelta (anche solo
  il FINALE), velocità 50–100%. Ogni sezione ha il proprio record.

### Audio e sincronizzazione

Nessuna traccia è inclusa. La canzone si carica **una volta** dalla schermata
**Audio**: il sito la salva in **IndexedDB (solo nel tuo browser)** e la
ripristina al riavvio. Il prompt iniziale “Scaricare la canzone?” apre il video
ufficiale con un disclaimer: **il download lo fa l'utente con i propri
strumenti, il sito non scarica e non distribuisce nulla**.

Di default la run parte **dall'inizio della traccia**; la spunta **“Salta
l'intro”** fa partire vicino al primo anello.

### Download automatico (server locale)

Il pulsante **“Scarica la canzone”** (nel prompt iniziale e in **Audio**) usa un
piccolo server locale che scarica l'audio del video ufficiale con **yt-dlp** e
lo passa al browser, che lo salva in IndexedDB. Richiede yt-dlp:

```sh
py -m venv tools/ytdlp
tools\ytdlp\Scripts\python -m pip install -U yt-dlp

npm run song-server   # in un terminale (porta 5198)
npm run dev           # in un altro (porta 5199)
```

Il server ascolta solo su `127.0.0.1`, scarica solo il video ufficiale indicato
e non è un proxy generico. Il file resta sul tuo computer e nel tuo browser,
per uso personale; il sito non ospita né distribuisce la canzone. Senza server
il pulsante lo segnala e si può sempre caricare il file manualmente.

Nella schermata di sync c'è la **waveform dell'audio** con zoom e scorrimento:
il marker è tuo e l'ascolto parte **dal punto scelto** (Spazio mette in pausa e
riprende da lì, non da capo). Puoi mettere il marker sul campanello (l'app
aggiunge il volo) o direttamente sul colpo.

I **due suoni di gioco** (`Otoge_circle.wav` per il lancio e `Otoge_click.wav`
per la rottura) sono inclusi in `src/assets/` e usati di default, senza sintesi.
In pausa c'è lo slider **“Volo anello”** per spostare il lancio di ±50–100 ms
senza toccare i colpi.

Se la registrazione contiene già i suoi campanelli e i suoi colpi, spegni
**“Suoni di gioco”**; altrimenti il gioco sintetizza un **campanello** alla
comparsa e un **colpo** quando prendi la nota, su un bus con compressore.

Lo slider **intro/offset audio** (anche in pausa) corregge il sync in 10 ms per
passo. Senza file restano i campanelli sintetici e si gioca lo stesso.

### Allineamento: pallini del video di riferimento

Il chart non usa più la correzione globale di +160 ms (era sbagliata) né
l'aggancio agli attacchi. I tempi vengono dai **pallini** del video
*“Drakegard 3 - Final Song with Input Prompts”* (`m9IHeSP71gI`): un pallino blu
cade su un bersaglio e sparisce esattamente sul colpo. Il video è la stessa
registrazione della canzone ufficiale, con offset misurato in cross-correlazione
(`song = video − 15.439 s`, drift < 10 ms su 440 s).

`tools/helper-chart.mjs` ricostruisce le 235 note: 229 dai pallini, 7 riempite
dai timestamp grezzi della community corretti con la mediana locale. Il file
`data/derived/helper-dots.json` contiene i pallini rilevati; l'output va in
`data/derived/aligned-timings.json` ed è usato da `tools/build-chart.mjs`.

```sh
npm run chart:helper   # pallini -> aligned-timings.json
npm run chart          # -> src/data/chart.json
npm run chart:grid     # griglia di quartine dalla registrazione (editor)
```

La prima nota cade a **24.728 ms** nella registrazione ufficiale: è l'ancora del
chart. I timestamp grezzi della community, confrontati coi pallini, danno
mediane da −5 a +69 ms: la vecchia correzione +160 spostava tutto in ritardo.
Gli offset per sezione restano solo come rifinitura.

### Vista Chart (allineamento a mano)

In **Pratica → Vedi il chart** la sezione si apre su un foglio con onda, note e
griglia di quartine/battute. Si trascinano le note col mouse (Shift = movimento
fine) o si usano ← / → (5 ms, con Shift 20 ms); il valore si salva per sezione o
per singola nota e vale anche in Autentica. La griglia è misurata sulla
registrazione ufficiale (`tools/beat-grid.mjs`), non sui BPM dichiarati.

## Fedeltà e limiti dichiarati

- **Chart**: 235 timestamp (234 note + chime) dai tool di pratica della community,
  incrociati con la guida GameFAQs di rojotrece: i conteggi per sezione combaciano
  esattamente (ZERO 25, FIVE 19, FOUR 18, THREE 21, TWO 31, ONE 34, ALL 86).
- I tempi sono ricostruiti dai pallini del video di riferimento (vedi sopra); la
  vecchia correzione globale di +160 ms è stata rimossa perché spostava il chart
  in ritardo di ~100–200 ms.
- **Campanello e colpo**: il campanello segna la comparsa dell'anello, il colpo
  arriva ~2 s dopo. Il chart usa come zero il primo **colpo** (come il tool della
  community); il gioco fa comparire l'anello due secondi prima e suona il
  campanello in quel momento.
- Le **finestre di giudizio** del gioco originale non sono documentate: qui sono
  ±150 ms (autentica) e ±220 ms (pratica), con Perfect ±70/±95 ms — volutamente
  permissive, per dare margine sul tempo.
- L'audio viene anticipato della latenza di uscita del browser, così il suono
  arriva insieme al visuale.
- Il **chime finale** è trattato come il gioco: cerchio bianco, poi il colpo
  quattro battiti dopo (a ~46 BPM), sul dialogo finale.
- La grafica è una ricreazione stilizzata procedurale (vuoto, occhio gigante,
  petali, Zero/Mikhail evocati come scie), non un port delle texture originali.

## Struttura

```
data/raw/            timings.txt, timings_grouping.txt (provenienza in README)
tools/build-chart.mjs  valida i dati e genera src/data/chart.json
server/song-server.mjs server locale (yt-dlp) per il pulsante "Scarica la canzone"
src/game/            audio (clock WebAudio, campanelli/colpi), judge, input, renderer, game loop
src/game/constants.ts  tempo di volo dell'anello (2000 ms), preroll
src/game/storage.ts    salvataggio della canzone in IndexedDB (locale)
src/assets/            circle.wav, click.wav (suoni di lancio/rottura forniti dall'utente)
src/ui/ui.ts         schermate: titolo, prompt canzone, pratica, audio, sync, pausa, risultati
src/data/chart.json  chart generato (non modificare a mano)
```

`npm run chart` rigenera il chart e stampa il riepilogo delle sezioni.

## Contesto: il recomp di Drakengard 3

Il recomp statico del gioco esiste ed è un progetto separato: **soyjxck/dod3-recomp**
(port nativo Windows/macOS via [ps3recomp](https://github.com/sp00nznet/ps3recomp),
D3D12/Metal/Vulkan, richiede la propria copia USA + update 1.01). Non ha un target
browser/WASM: questa ricreazione è la strada praticabile per giocare *solo* la
parte ritmica nel browser.

## Fonti

- Timings e sezioni BPM: [dieg-go/dod3-helper-web](https://github.com/dieg-go/dod3-helper-web),
  a sua volta port di [Noremos/Drakengard3-helper](https://github.com/Noremos/Drakengard3-helper)
- Conteggio note e struttura del fight: “Drakengard 3 - End Boss Guide” di rojotrece (GameFAQs, 2015)
- Contesto recomp: [soyjxck/dod3-recomp](https://github.com/soyjxck/dod3-recomp), [sp00nznet/ps3recomp](https://github.com/sp00nznet/ps3recomp)

Drakengard 3 e “The Final Song” appartengono ai rispettivi titolari. Questo
progetto è una ricreazione fan, senza asset originali e senza scopo di lucro.

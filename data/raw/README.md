# Dati grezzi e provenienza

Questa cartella contiene i dati del chart, non asset del gioco.

- `timings.txt` — 235 timestamp in millisecondi del boss finale ("The Final Song",
  Branch D) di Drakengard 3. Sono i tempi usati dai tool di pratica della community
  (`Noremos/Drakengard3-helper`, poi portati sul web in `dieg-go/dod3-helper-web`),
  ricavati con rilevamento pixel da una cattura video a 59.94 fps. Il file contiene
  234 note suonate + il chime finale (l'ultimo valore, ~6:34).

- `timings_grouping.txt` — sezioni di tempo (BPM) della canzone, dallo stesso
  progetto, usate per il battito visivo e per la decelerazione finale (128 → 46 BPM).

- La *sequenza* delle note (quante per sezione, e che il fight sia puro ritmo con
  qualsiasi pulsante) viene dalla guida GameFAQs di rojotrece
  ("Drakengard 3 - End Boss Guide", aggiornata 25/01/2015):
  ZERO 25 · FIVE 19 · FOUR 18 · THREE 21 · TWO 31 · ONE 34 · ALL 86 = 234 note,
  più il chime finale. La verifica incrociata con i 235 timestamp è esatta.

Nessun file audio o grafico del gioco è incluso: la canzone va caricata
dall'utente (propria copia) oppure si usa la modalità sintetica.

Questo progetto è una ricreazione amatoriale non ufficiale, non affiliata a
Square Enix, Access Games o Sony. Drakengard 3 e i suoi contenuti appartengono
ai rispettivi titolari.

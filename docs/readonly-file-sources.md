# Cartelle condivise in sola lettura: Word, PDF, Excel

MySQL-MCP-Bridge permette di autorizzare cartelle locali, dischi Windows mappati (S:\, M:\, Z:\) e percorsi di rete UNC (\\SERVER\Condivisa\Documenti). I nuovi strumenti di lettura sono disponibili nello stesso endpoint MCP dei database MySQL e Access.

## Configurazione con Electron

1. Chiudi il precedente server MCP sulla porta 3001, se attivo.
2. Avvia Electron con npm ci e npm run dev.
3. Apri **Standalone Sources** e clicca **+ Folder / network drive**.
4. Inserisci un ID univoco, ad esempio archivio_s, e scegli la cartella con **Browse folders**. Per condivisioni UNC puoi scrivere manualmente il percorso.
5. Premi **Test folder access**. L'utente Windows che esegue Electron deve già avere il permesso di leggere la condivisione.
6. Lascia selezionato **Enabled** e premi **Save & start MCP**. Se il server era già in esecuzione, fermalo e riavvialo dopo aver salvato le modifiche.
7. Riconnetti OpenCode su http://127.0.0.1:3001/mcp usando lo stesso Bearer Token fisso.

Non occorre modificare opencode.json se è già configurato. Puoi aggiungere e disabilitare più cartelle indipendentemente, senza toccare MySQL.

Le lettere dei dischi mappati a volte non sono disponibili per servizi Windows eseguiti in un'altra sessione. In tali casi usa un percorso UNC.

## Comandi MCP

| Strumento | Descrizione |
| --- | --- |
| list_sources | Elenca database e cartelle autorizzate |
| list_directory | Elenca file e sottocartelle |
| get_file_info | Legge dimensioni, tipo e data di modifica |
| read_text_file | Legge TXT, CSV, JSON, SQL, log e codice |
| read_document | Estrae testo da PDF, Word DOC/DOCX, Excel XLS/XLSX |
| search_files | Cerca file per nome |
| search_text | Cerca testo dentro file supportati |

Ogni comando relativo ai file utilizza source_id e un path relativo alla cartella radice. Per esempio, se la radice autorizzata è S:\, usare un path come report/ottobre.xlsx, non un percorso assoluto.

## Formati e limiti

- PDF: testo selezionabile, prime 40 pagine; i PDF con sole scansioni richiedono OCR.
- Word: DOCX e DOC binario tradizionale, estrazione del testo dei paragrafi; eventuali macro non vengono eseguite.
- Excel: XLSX e XLS binario BIFF8 (Excel 97-2003), primi 6 fogli, fino a 300 righe e 35 colonne per foglio; valori memorizzati delle formule, nessuna esecuzione di macro.
- File di testo: TXT, CSV, JSON, XML, SQL, MD, LOG e formati di codice comuni.
- File protetti da password, vecchi XLS BIFF2/BIFF5 (antecedenti a Excel 97), OCR e oggetti incorporati non sono supportati. I documenti DOC particolarmente vecchi o danneggiati possono non essere leggibili.
- Dimensione massima per file 12 MiB; risposta massima 100000 caratteri, elenchi massimo 250 elementi, ricerca limitata a profondità e numero di file.

## Sicurezza

Nessuno strumento MCP consente scrittura, esecuzione, eliminazione, spostamento o rinomina di file. Sono vietati percorsi assoluti, sequenze di risalita ../, collegamenti e junction diretti fuori dalla radice, e percorsi noti per segreti quali .env, .ssh, chiavi private.

Questi filtri non garantiscono di riconoscere qualunque file riservato: **autorizza soltanto le cartelle che intendi rendere leggibili all'AI**. Idealmente concedi anche permessi SMB/NTFS di sola lettura all'account Windows che esegue il Bridge.

Il token Bearer rimane obbligatorio per le richieste protette. Nella modalità gestita Electron ngrok resta disattivato. Quando chiudi Electron, il server gestito si arresta.

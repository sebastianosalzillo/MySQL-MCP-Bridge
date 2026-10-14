# Accesso LAN sicuro a MySQL MCP Bridge

La versione aggiornata permette di usare lo stesso MCP da più PC **nella medesima sottorete locale**. Rimangono invariati gli strumenti di sola lettura per MySQL, Access e file (Word, PDF, Excel).

## Sul PC principale

1. Aggiorna l'app, aprila e verifica che il server precedente sulla porta 3001 sia arrestato.
2. Vai alla scheda **MCP + ngrok**, sezione **Accesso dalla rete locale**.
3. Seleziona **Consenti accesso dalla rete locale (LAN)**. È disattivato per impostazione predefinita.
4. Scegli la scheda/IP privato della LAN, ad esempio 192.168.1.100. Se hai più schede (VPN, Wi-Fi, Ethernet), scegli quella realmente utilizzata dagli altri PC. Usa **Aggiorna IP disponibili** quando serve.
5. Verifica di avere un **Bearer Token fisso** di almeno 24 caratteri, poi premi **Salva impostazioni LAN**.
6. Vai su **Standalone Sources** e avvia con **Save & start MCP**. Se già avviato, usa prima **Stop standalone MCP**.
7. Controlla la nuova voce **LAN endpoint** e copia l'URL.

Esempio URL per gli altri PC:

    http://192.168.1.100:3001/mcp

Il server continua ad ascoltare anche su 127.0.0.1:3001 per l'OpenCode installato sul PC principale. Non modifica MySQL, non apre un servizio di scrittura sui documenti e non modifica il token esistente.

## Windows Firewall sul PC principale

Il server non modifica automaticamente Windows Firewall. Se la connessione da un altro PC non funziona, verifica che la rete sia impostata su **Privata** (non Pubblica) e crea una regola strettamente limitata a LAN, porta e IP scelti.

In Electron puoi premere **Copia comando Windows Firewall** ed eseguirlo in **PowerShell come amministratore** sul PC principale. Esempio, sostituendo l'IP e la porta reali:

    New-NetFirewallRule -DisplayName "MySQL MCP Bridge LAN 3001" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.100 -LocalPort 3001 -RemoteAddress LocalSubnet -Profile Private

Per rimuovere la regola in futuro:

    Remove-NetFirewallRule -DisplayName "MySQL MCP Bridge LAN 3001"

Non abilitare il port forwarding TCP 3001 sul router. Non attivare l'accesso per le reti pubbliche.

## Su ogni altro PC della LAN

Nel suo file opencode.json, configura il MCP remoto come sempre, cambiando **soltanto l'URL**:

    {
      "$schema": "https://opencode.ai/config.json",
      "mcp": {
        "posmanager": {
          "type": "remote",
          "url": "http://192.168.1.100:3001/mcp",
          "enabled": true,
          "oauth": false,
          "headers": {
            "Authorization": "Bearer INSERISCI_LO_STESSO_TOKEN_DI_ELECTRON"
          }
        }
      }
    }

L'indirizzo non è 127.0.0.1 sul secondo PC: quell'indirizzo indica il secondo PC stesso.

Se il comando opencode mcp list segnala un errore, verifica che entrambi i PC si trovino sulla stessa subnet, che la porta 3001 non sia occupata da un altro processo, che Windows Firewall consenta TCP 3001 per il profilo Privato e che il Bearer Token sia identico a quello di Electron.

Verifica di base da PowerShell sul secondo PC:

    Test-NetConnection 192.168.1.100 -Port 3001

Se il test TCP riesce ma OpenCode risponde 401, il token è errato. Se risponde 403, verifica l'IP scelto, la sottorete, il valore Host e l'eventuale header Origin. Se ricevi connection refused o timeout, controlla server e firewall.

## Confini di sicurezza

- Vengono aperti due listener **specifici**: 127.0.0.1 e l'IP privato selezionato. Nessun 0.0.0.0 e nessuna esposizione su tutte le interfacce.
- Il server MCP controlla anche che l'indirizzo IP del client sia nella **stessa sottorete** dell'interfaccia selezionata. Se i PC usano sottoreti/VLAN differenti, non possono collegarsi in questa modalità.
- È richiesto il Bearer Token (minimo 24 caratteri); i nomi host e Origin HTTP restano controllati.
- L'endpoint di diagnostica /health è disponibile solo dalla macchina locale; il servizio amministrativo AI continua a rimanere su 127.0.0.1:3002.
- Le funzioni remote del MCP multisorgente restano **READ ONLY**; il server Electron legacy a scrittura non è esposto alla LAN da questa impostazione.
- La connessione LAN usa **HTTP senza cifratura**. Il Bearer Token e i dati dei documenti transitano nella rete locale. Usa questa opzione soltanto su reti aziendali fidate; per reti non attendibili occorrono HTTPS/VPN, gestione degli account per dispositivo e limitazioni più forti.
- Non salvare il Bearer Token in repository e non condividerlo pubblicamente. È consigliato rigenerarlo prima di abilitare la LAN se è già stato esposto.

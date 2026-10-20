# Leitstand Probe

Prüft für die Werbeschneiderei, ob die Anfrageformulare der betreuten Betriebe
wirklich ankommen. Sechsmal am Tag, angestoßen aus n8n, schickt ein Browser jedes Formular aus
`strecken.json` mit einer Probe-Adresse ab. Der n8n-Workflow des Betriebs
erkennt die Probe, schickt sie weder an den Betrieb noch ins CRM, sondern als
Mail an eine Prüfung bei healthchecks.io. Bleibt diese Mail aus, kommt eine
Meldung.

Die Probe zählt nirgends als Anfrage: Google, Meta und alle anderen fremden
Dienste sind im Browser gesperrt.

## Geheimnisse

| Name | Inhalt |
| --- | --- |
| `PRUEFUNGEN` | JSON, Strecke zu Kennung der Prüfung bei healthchecks.io |
| `PROBE_TELEFON` | Telefonnummer, die die Probe einträgt |

## Von Hand

```bash
npm install
node probe.mjs --trocken
```

`--trocken` füllt bis vor das Absenden und schickt nichts ab. Fachliche
Beschreibung und Betrieb stehen im OS der Werbeschneiderei (spec/26,
n8n/leitstand/README.md).

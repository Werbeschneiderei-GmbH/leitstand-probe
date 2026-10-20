// =============================================================================
// Probe des Leitstands der Werbeschneiderei (im OS spec/26, Teil C, Schritt 2).
//
// Füllt das echte Formular jeder Strecke aus und schickt es ab, mit der
// Adresse anfragen+leitstand-<Prüfung>@werbeschneiderei.at. Die Test-Weiche im
// n8n-Workflow des Kunden erkennt sie, lässt OS und Odoo aus und schickt die
// Mail an <Prüfung>@hc-ping.com. Das zählt bei healthchecks.io als
// Lebenszeichen der Strecke. Bleibt es aus, meldet healthchecks.io. Dieses
// Skript urteilt nicht, es füllt nur aus.
//
// Kein Rezept je Formular: der Ausfüller wählt je Schritt die erste Antwort,
// bei Ja und Nein immer Ja (Ausschlussfragen der Bewerbungen), und füllt die
// Kontaktfelder nach Art und Beschriftung. Ändert ein Betrieb sein Formular,
// läuft die Probe meist weiter.
//
// Google, Meta und jeder andere fremde Dienst sind gesperrt: durch dürfen nur
// die Seite selbst und Onepage. So zählt keine Probe als Abschluss.
//
//   PRUEFUNGEN='{"schmid-kontakt":"<uuid>"}' PROBE_TELEFON=... node probe.mjs [--trocken] [strecke ...]
//   --trocken  füllt bis vor das Absenden und schickt nichts ab
// =============================================================================

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const STRECKEN = JSON.parse(readFileSync(new URL("./strecken.json", import.meta.url), "utf8"));
// Kennungen der Prüfungen bei healthchecks.io je Strecke. Geheimnis, nicht im
// öffentlichen Code: mit einer Kennung ließe sich ein Lebenszeichen fälschen.
const PRUEFUNGEN = JSON.parse(process.env.PRUEFUNGEN || "{}");
const args = process.argv.slice(2);
const TROCKEN = args.includes("--trocken");
const auswahl = args.filter((a) => !a.startsWith("--"));
// Julians Handy: greift die Weiche einmal nicht, ruft der Betrieb ihn an und
// keinen Fremden. Die Beispielnummer nur im Trockenlauf, der nichts abschickt.
const TELEFON = process.env.PROBE_TELEFON || (TROCKEN ? "+43 664 1234567" : null);
if (!TELEFON) {
  console.error("PROBE_TELEFON fehlt, ohne sie schickt die Probe nichts ab.");
  process.exit(2);
}
// Dieselbe Nummer ohne Ländervorwahl und ohne führende Null.
const NATIONAL = TELEFON.replace(/\D/g, "").replace(/^00/, "").replace(/^43/, "").replace(/^0/, "");

// Seite, Onepage und deren Auslieferung. Messserver der Betriebe (etwa
// load.data.garten-schmid.at) liegen auf Unterdomains der Seite, deshalb die
// zweite Sperre.
const ERLAUBT = /(^|\.)(onecdn\.io|onepage\.me|onepage\.io|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.bunny\.net|b-cdn\.net|mediadelivery\.net)$/;
const MESSUNG = /(^|\.)(load|data|sgtm|gtm|ss|track|analytics)\./;

const WEITER = /^(weiter|nächste|next|fortfahren)/i;
const ABSENDEN = /(absenden|senden|abschicken|anfragen|anfordern|bewerben|sichern|einholen|erstberatung|gespräch)/i;
const ZUSTIMMUNG = /(datenschutz|zustimm|einverstanden|akzeptier|einwillig|consent)/i;
const ERFOLG = /(danke|vielen dank|erfolgreich|erhalten|wir melden uns|eingegangen)/i;

/** Wert für ein Eingabefeld nach Art und Beschriftung, null für Felder, die leer bleiben dürfen. */
function wertFuer(f, email) {
  const s = `${f.type} ${f.autocomplete} ${f.name} ${f.id} ${f.placeholder} ${f.label}`.toLowerCase();
  if (f.type === "email" || /e-?mail/.test(s)) return email;
  if (f.type === "tel" || /telefon|phone|handy|mobil/.test(s)) return TELEFON;
  if (/postleitzahl|postal|plz|zip/.test(s)) return "4320";
  if (/vorname|given|first/.test(s)) return "Leitstand";
  if (/nachname|family|last|surname/.test(s)) return "Probe";
  if (/\bort\b|stadt|city|gemeinde/.test(s)) return "Perg";
  if (/stra(ss|ß)e|street|adresse|address/.test(s)) return "Gartenstraße 8";
  if (/firma|unternehmen|company/.test(s)) return "Werbeschneiderei";
  if (/name/.test(s)) return "Leitstand Probe";
  if (f.tag === "textarea") return "Probe des Leitstands der Werbeschneiderei, bitte ignorieren.";
  if (f.type === "number") return "100";
  if (f.type === "text" || f.type === "") return "Probe";
  return null;
}

async function waehle(page, i) {
  const feld = page.locator(`[data-probe="${i}"]`);
  const marke = page.locator(`[data-probe-marke="${i}"]`);
  // Am linken Rand, dort sitzt das Kästchen: mitten in der Beschriftung der
  // Zustimmung liegt der Link zur Datenschutzerklärung.
  if (await marke.count()) await marke.first().click({ position: { x: 6, y: 6 } });
  else await feld.click({ force: true });
  // Karten springen beim Klick zur nächsten Frage, dann ist das Feld schon weg.
  if (!(await feld.isChecked({ timeout: 500 }).catch(() => true))) await feld.check({ force: true }).catch(() => {});
}

/** Ein Schritt: wählen, ausfüllen, weiter. Liefert, was getan wurde, oder "absenden", wenn nur noch das fehlt. */
async function schritt(page, email) {
  const lage = await page.evaluate(
    ([ZUSTIMMUNG_Q]) => {
      const zustimmung = new RegExp(ZUSTIMMUNG_Q, "i");
      const sicht = (e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden";
      };
      const beschriftung = (e) =>
        ((e.labels && e.labels[0] && e.labels[0].innerText) || e.closest("label")?.innerText || e.getAttribute("aria-label") || "").trim();
      const felder = [...document.querySelectorAll("input,textarea,select")]
        .filter((e) => !["hidden", "submit", "button"].includes(e.type))
        .filter((e) => sicht(e) || (["radio", "checkbox"].includes(e.type) && e.closest("label") && sicht(e.closest("label"))))
        .map((e, i) => {
          e.setAttribute("data-probe", String(i));
          // Onepage versteckt Auswahlfelder hinter ihrer Beschriftung. Ein
          // Klick auf das Feld selbst erreicht React nicht, einer auf die
          // Beschriftung schon.
          const marke = (e.labels && e.labels[0]) || e.closest("label");
          if (marke) marke.setAttribute("data-probe-marke", String(i));
          return {
            i, tag: e.tagName.toLowerCase(), type: e.type || "", name: e.name || "", id: e.id || "",
            autocomplete: e.autocomplete || "", placeholder: e.placeholder || "", label: beschriftung(e).slice(0, 80),
            leer: e.type === "radio" || e.type === "checkbox" ? !e.checked : !e.value, zustimmung: zustimmung.test(beschriftung(e)),
          };
        });
      // Antwortkarten der Baukasten-Strecken (Weix): Knöpfe in einem Optionen-Block.
      const karten = [...document.querySelectorAll("[class*=_options] > *, [class*=options] button")]
        .filter(sicht)
        .map((e, i) => {
          e.setAttribute("data-probe-karte", String(i));
          return { i, text: e.innerText.trim().replace(/\s+/g, " ").slice(0, 60) };
        });
      // Der Abschnitt mit dem Kontaktfeld: nur dort sitzt der Absende-Knopf,
      // gleich lautende Knöpfe anderswo springen nur zum Formular.
      const kontakt = [...document.querySelectorAll("input[type=email],input[type=tel]")].find(sicht);
      const abschnitt = kontakt && (kontakt.closest("section") || kontakt.closest("form") || document.body);
      const knoepfe = [...document.querySelectorAll("button,[role=button],a[class*=button]")]
        .filter(sicht)
        .map((e, i) => {
          e.setAttribute("data-probe-knopf", String(i));
          return { i, text: e.innerText.trim().replace(/\s+/g, " ").slice(0, 60), aus: e.disabled, imFormular: !!abschnitt && abschnitt.contains(e) };
        });
      return { felder, karten, knoepfe };
    },
    [ZUSTIMMUNG.source],
  );

  const getan = [];
  // Auswahl: je Gruppe eine Antwort, bei Ja und Nein Ja.
  const gruppen = new Map();
  for (const f of lage.felder.filter((f) => (f.type === "radio" || f.type === "checkbox") && !f.zustimmung)) {
    const g = f.name || f.id;
    if (!gruppen.has(g)) gruppen.set(g, []);
    gruppen.get(g).push(f);
  }
  for (const [, optionen] of gruppen) {
    if (optionen.some((o) => !o.leer)) continue;
    const wahl = optionen.find((o) => /^ja\b/i.test(o.label)) ?? optionen[0];
    await waehle(page, wahl.i);
    getan.push(`wählt „${wahl.label.replace(/\s+/g, " ")}“`);
  }
  for (const f of lage.felder.filter((f) => f.zustimmung && f.leer)) {
    await waehle(page, f.i);
    getan.push("stimmt zu");
  }
  for (const f of lage.felder.filter((f) => f.tag === "select" && f.leer)) {
    const wert = await page.locator(`[data-probe="${f.i}"] option`).evaluateAll((o) => o.map((x) => x.value).find((v) => v));
    if (wert) {
      await page.locator(`[data-probe="${f.i}"]`).selectOption(wert);
      getan.push(`wählt im Feld „${f.label.split("\n")[0]}“`);
    }
  }
  for (const f of lage.felder.filter((f) => !["radio", "checkbox"].includes(f.type) && f.tag !== "select" && f.leer)) {
    const wert = wertFuer(f, email);
    if (wert === null) continue;
    const feld = page.locator(`[data-probe="${f.i}"]`);
    await feld.fill(wert);
    // Onepage setzt die Vorwahl +43 selbst davor und verwirft eine Nummer, die
    // sie schon trägt. Dann ohne Vorwahl.
    if (f.type === "tel" && !(await feld.inputValue()).replace(/\D/g, "").endsWith(NATIONAL)) await feld.fill(NATIONAL);
    getan.push(`füllt „${f.label || f.placeholder || f.name || f.type}“`);
  }
  if (getan.length === 0 && lage.karten.length) {
    const wahl = lage.karten.find((k) => /^ja\b/i.test(k.text)) ?? lage.karten[0];
    await page.locator(`[data-probe-karte="${wahl.i}"]`).click();
    getan.push(`wählt Karte „${wahl.text}“`);
    return getan;
  }

  const weiter = lage.knoepfe.find((k) => WEITER.test(k.text) && !k.aus);
  if (weiter) {
    await page.locator(`[data-probe-knopf="${weiter.i}"]`).click();
    return [...getan, `klickt „${weiter.text}“`];
  }
  // Formulare im Fenster (LKW, Kramer) öffnen erst über einen Knopf auf der Seite.
  if (getan.length === 0 && lage.felder.length === 0 && lage.karten.length === 0) {
    const start = lage.knoepfe.find((k) => ABSENDEN.test(k.text) || /beratung/i.test(k.text));
    if (start) {
      await page.locator(`[data-probe-knopf="${start.i}"]`).click();
      return [`öffnet „${start.text}“`];
    }
  }
  const hatKontakt = lage.felder.some((f) => f.type === "email" || f.type === "tel");
  if (hatKontakt) {
    const absenden = lage.knoepfe.filter((k) => k.imFormular && ABSENDEN.test(k.text) && !k.aus).pop();
    if (absenden) return [...getan, { absenden: absenden.i, text: absenden.text }];
  }
  if (getan.length === 0) getan.lage = lage.knoepfe.map((k) => k.text).filter(Boolean).slice(0, 12).join(" | ");
  return getan;
}

async function probe(browser, strecke) {
  const pruefung = PRUEFUNGEN[strecke.strecke] ?? (TROCKEN ? "00000000-0000-0000-0000-000000000000" : null);
  if (!pruefung) return { ok: false, protokoll: [`keine Prüfung in PRUEFUNGEN`] };
  const email = `anfragen+leitstand-${pruefung}@werbeschneiderei.at`;
  const ctx = await browser.newContext({ locale: "de-AT", viewport: { width: 1280, height: 900 } });
  const seite = new URL(strecke.url).hostname.replace(/^(www|ads)\./, "");
  const gesperrt = new Set();
  await ctx.route("**/*", (r) => {
    const host = new URL(r.request().url()).hostname;
    const eigen = host === seite || host.endsWith("." + seite);
    if ((eigen && !MESSUNG.test(host)) || ERLAUBT.test(host)) return r.continue();
    gesperrt.add(host);
    return r.abort();
  });
  const page = await ctx.newPage();
  // Was nach dem Klick an Onepage ging, für das Protokoll.
  const posts = [];
  page.on("response", (antwort) => {
    if (antwort.request().method() !== "POST") return;
    const u = new URL(antwort.url());
    if (!/\/_t(\/|$)/.test(u.pathname)) posts.push(`${u.host}${u.pathname} ${antwort.status()}`);
  });
  const protokoll = [];
  try {
    await page.goto(strecke.url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.getByRole("button", { name: "Ablehnen" }).first().click({ timeout: 3_000 }).catch(() => {});
    for (let n = 0; n < 25; n++) {
      const getan = await schritt(page, email);
      const ende = getan.find((g) => typeof g === "object");
      protokoll.push(...getan.filter((g) => typeof g === "string"));
      if (ende) {
        protokoll.push(`${TROCKEN ? "würde klicken" : "klickt"} „${ende.text}“`);
        if (TROCKEN) return { ok: true, protokoll };
        // Bestätigt ist erst Text, der nach dem Klick neu erscheint: „Danke“
        // steht auf Landingpages sonst schon in den Kundenstimmen.
        const vorher = await page.evaluate((erfolg) => (document.body.innerText.match(new RegExp(erfolg, "gi")) || []).length, ERFOLG.source);
        posts.length = 0;
        await page.locator(`[data-probe-knopf="${ende.absenden}"]`).click();
        // Beleg ist allein die Antwort von Onepage auf die Absendung: den Dank
        // zeigt das Formular teils schon vorher, und bei Kramer schließt sich
        // das Fenster ganz ohne Dank.
        await page.waitForResponse((a) => a.request().method() === "POST" && /crm-service\/rpc/.test(a.url()), { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        const angekommen = await page.evaluate(
          ([erfolg, vorher]) => (document.body.innerText.match(new RegExp(erfolg, "gi")) || []).length > vorher,
          [ERFOLG.source, vorher],
        );
        const rpc = posts.filter((x) => /crm-service\/rpc/.test(x));
        const angenommen = rpc.length > 0 && rpc.every((x) => / 2\d\d$/.test(x));
        // Ohne Bestätigung: was im Formular steht, etwa eine Fehlermeldung.
        const formular = angenommen
          ? ""
          : await page
              .locator(`[data-probe-knopf="${ende.absenden}"]`)
              .evaluate((e) => (e.closest("section") || document.body).innerText.replace(/\s+/g, " ").slice(0, 300))
              .catch(() => "Knopf nicht mehr da");
        return {
          ok: angenommen,
          protokoll: [
            ...protokoll,
            angenommen ? "von Onepage angenommen" : "von Onepage nicht angenommen",
            angekommen ? "Dank erschienen" : "kein Dank erschienen",
            `POST: ${posts.join("; ") || "keiner"}`,
            `gesperrt: ${[...gesperrt].filter((h) => !h.endsWith("bunnyinfra.net")).join(" ") || "nichts"}`,
            ...(formular ? [`Formular: ${formular}`] : []),
          ],
        };
      }
      if (getan.length === 0) return { ok: false, protokoll: [...protokoll, `steckt fest, sichtbare Knöpfe: ${getan.lage}`] };
      await page.waitForTimeout(800);
    }
    return { ok: false, protokoll: [...protokoll, "nach 25 Schritten nicht am Ende"] };
  } catch (fehler) {
    return { ok: false, protokoll: [...protokoll, `Fehler: ${String(fehler.message).split("\n")[0]}`] };
  } finally {
    await ctx.close();
  }
}

// Onepage weist mehrere Absendungen kurz hintereinander an dieselbe Seite mit
// 403 ab (Weix, 20.10.2026). Deshalb die Seiten abwechselnd und je Seite eine
// Pause zwischen zwei Absendungen.
const ABSTAND_MS = 90_000;
const zuletzt = new Map();
const host = (s) => new URL(s.url).hostname;
const gewaehlt = STRECKEN.filter((s) => auswahl.length === 0 || auswahl.includes(s.strecke));
const reihe = [];
for (const s of gewaehlt) {
  const rang = gewaehlt.filter((t) => host(t) === host(s)).indexOf(s);
  reihe.push({ s, rang });
}
reihe.sort((a, b) => a.rang - b.rang);
async function warteAuf(seite) {
  const frei = (zuletzt.get(seite) ?? 0) + ABSTAND_MS - Date.now();
  if (frei > 0 && !TROCKEN) await new Promise((r) => setTimeout(r, frei));
  zuletzt.set(seite, Date.now());
}

const browser = await chromium.launch();
let gescheitert = 0;
for (const { s: strecke } of reihe) {
  // Scheitert der Browser, gleich ein zweites Mal. Was danach in n8n oder bei
  // der Mail hängt, meldet healthchecks.io.
  await warteAuf(host(strecke));
  let ergebnis = await probe(browser, strecke);
  if (!ergebnis.ok) {
    await warteAuf(host(strecke));
    ergebnis = await probe(browser, strecke);
  }
  if (!ergebnis.ok) gescheitert++;
  console.log(`${ergebnis.ok ? "ok    " : "FEHLER"} ${strecke.strecke}: ${ergebnis.protokoll.join(", ")}`);
}
await browser.close();
process.exit(gescheitert ? 1 : 0);

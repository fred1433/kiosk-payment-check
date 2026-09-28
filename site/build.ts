// Builds site/dist/kiosk-payments/index.html from the bench results. Run: deno task site
// Every number on the page comes from site/data/bench*.json, produced by `deno task bench`.

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const root = new URL("./", import.meta.url);
const pglite: Json = JSON.parse(await Deno.readTextFile(new URL("data/bench.json", root)));
let server: Json | null = null;
try {
  server = JSON.parse(await Deno.readTextFile(new URL("data/bench.postgres.json", root)));
} catch { /* optional */ }

// The two runs must agree on every measure, or the page refuses to build.
const strip = (d: Json) =>
  JSON.stringify(d.families.map((f: Json) => f.results.map((r: Json) => ({ id: r.id, pass: r.pass, m: { ...r.module, reason: undefined } }))));
const sameOnServer = server ? strip(server) === strip(pglite) : null;
if (server && !sameOnServer) throw new Error("PGlite and Postgres server results differ; not building.");

const esc = (s: unknown) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const signed = (c: number) => `${c > 0 ? "+" : c < 0 ? "-" : ""}${(Math.abs(c) / 100).toFixed(2)}`;

// ------------------------------------------------------------------ the receipt (hero)
const hero = pglite.hero;
const rec = hero.recovered.rows as Json[];
const unr = hero.unresolved.rows as Json[];
let shared = 0;
while (shared < rec.length && shared < unr.length && rec[shared].text === unr[shared].text) shared++;
const laneName: Record<string, string> = { kiosk: "KIOSK", bank: "BANK", register: "REGISTER", staff: "STAFF" };
const row = (r: Json) =>
  `<li class="ev ${r.tone ?? ""}"><span class="t">${esc(r.at)}</span><span class="l">${laneName[r.lane]}</span><span class="x">${esc(r.text)}</span></li>`;

const orderId = String(hero.recovered.posOrderId).slice(0, 8).toUpperCase();
const receipt = `
<figure class="receipt-wrap" aria-label="One fictional kiosk order, event by event">
  <div class="paper main">
    <p class="rc-center">STORE 1042 &nbsp; KIOSK 7 &nbsp; QUICK CHECKOUT</p>
    <p class="rc-center dim">28 SEP 2026 &nbsp; 12:02 PM &nbsp; ORDER ${esc(orderId)}</p>
    <p class="rule" aria-hidden="true"></p>
    <ul class="items">
      <li><span>Flower, 3.5 g</span><span>40.00</span></li>
      <li><span>Pre-roll pack, 5 x 0.5 g</span><span>22.00</span></li>
      <li><span>Gummies, 100 mg</span><span>18.00</span></li>
      <li class="sub"><span>Tax (fictional 20%)</span><span>16.00</span></li>
      <li class="sub"><span>Bank payment fee, disclosed</span><span>1.50</span></li>
      <li class="tot"><span>APPROVED BY SHOPPER</span><span>97.50</span></li>
    </ul>
    <p class="rule" aria-hidden="true"></p>
    <ol class="events">${rec.slice(0, shared).map(row).join("")}</ol>
  </div>
  <div class="fork">
    <div class="paper tail ok">
      <p class="tail-h">The register had it</p>
      <ol class="events">${rec.slice(shared).map(row).join("")}</ol>
      <ul class="totals">
        <li><span>BANK CAPTURE</span><span>${usd(hero.recovered.measures.captureCents)}</span></li>
        <li><span>REGISTER SAYS</span><span>PAID</span></li>
        <li><span>GOODS</span><span>HAND OVER</span></li>
      </ul>
    </div>
    <div class="paper tail stop">
      <p class="tail-h">The register never got it</p>
      <ol class="events">${unr.slice(shared).map(row).join("")}</ol>
      <ul class="totals">
        <li><span>BANK CAPTURE</span><span>${usd(hero.unresolved.measures.captureCents)}</span></li>
        <li class="red"><span>REGISTER SAYS</span><span>NOT PAID</span></li>
        <li class="red"><span>STAFF</span><span>DO NOT COLLECT AGAIN</span></li>
      </ul>
    </div>
  </div>
  <figcaption>Same order, same timeout. Times from the simulated clock. Rows are the module's own event journal.</figcaption>
</figure>`;

// ------------------------------------------------------------------ the bench table
const endingOf = (r: Json) => {
  const o = r.module.outcome as string;
  if (o === "ready_for_pickup") return { label: "Recovered", cls: "" };
  if (o === "no_charge") return { label: "Nothing charged", cls: "" };
  if (o === "saved_reference_not_usable" || o === "reauthentication_required") return { label: "Refused", cls: "" };
  if (o === "needs_new_consent") return { label: "Shopper approves again", cls: "amber" };
  if (r.id === "7b") return { label: "Refund refused", cls: "" };
  return { label: "Person decides", cls: "red" };
};
const moneyCell = (m: Json) => {
  if (!m.movements.length) return `<span class="dim">none settled</span>`;
  return m.movements.map((x: Json) => `<span class="mv ${x.amountCents < 0 ? "neg" : ""}">${signed(x.amountCents)}${x.returnCode ? ` ${x.returnCode}` : ""}</span>`).join(" ");
};
const naiveLine = (r: Json) => {
  const n = r.naive;
  if (!n) return "";
  const bits: string[] = [];
  bits.push(`${n.debits} debit${n.debits === 1 ? "" : "s"}`);
  bits.push(`${n.orders} order${n.orders === 1 ? "" : "s"}`);
  bits.push(`register ${n.registerPaid === "yes" ? "paid" : "unpaid"}`);
  if (n.recordedNetCents !== undefined && n.recordedNetCents !== n.bankNetCents) bits.push(`books ${usd(n.recordedNetCents)} for ${usd(n.bankNetCents)} received`);
  return `<p class="naive">Naive baseline, same fault: ${bits.join(", ")}; it reports “${esc(n.belief.replaceAll("_", " "))}”.</p>`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const mline = (r: Json, e: { label: string; cls: string }) => {
  const m = r.module;
  const settled = m.movements.length ? m.movements.map((x: Json) => signed(x.amountCents) + (x.returnCode ? " " + x.returnCode : "")).join(" ") : "none settled";
  return `<p class="mline"><span class="end ${e.cls}">${e.label}</span>${m.exposureCents ? `<span class="exp"> store short ${usd(m.exposureCents)}</span>` : ""}<br>${plural(m.submissions, "submission")}, ${plural(m.debits, "debit")}, ${plural(m.orders, "order")}, register ${m.registerPaid === "yes" ? "paid" : "unpaid"}, ${settled}</p>`;
};
const cell = (label: string, v: string, cls = "num") => `<td class="${cls}" data-l="${label}">${v}</td>`;

const tally = (rs: Json[]) => {
  const c = new Map<string, number>();
  for (const r of rs) c.set(endingOf(r).label, (c.get(endingOf(r).label) ?? 0) + 1);
  return `${rs.length} sequences: ` + [...c].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ");
};
const SHOW_NOTES = new Set(["2c", "4b", "5a", "6b", "7a", "7d"]);
const families = pglite.families as Json[];
const totalSeq = families.reduce((a, f) => a + f.results.length, 0);
const personEndings = families.flatMap((f) => f.results).filter((r: Json) => endingOf(r).cls === "red").length;

const benchRows = families.map((f, fi) => `
  <tbody class="fam">
    <tr class="fam-h"><th colspan="7" scope="rowgroup"><button type="button" class="fam-toggle" aria-expanded="true"><span class="fn">${fi + 1}</span> ${esc(f.title)}<span class="dem">${esc(f.demonstrates)}</span><span class="tally">${tally(f.results)}</span></button></th></tr>
    ${
  f.results.map((r: Json) => {
    const m = r.module;
    const e = endingOf(r);
    const shortId = (t: string) => t.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "$1");
    const reason = e.cls === "red" || e.cls === "amber" ? `<p class="reason ${e.cls}">${esc(shortId(m.reason ?? ""))}</p>` : "";
    const note = SHOW_NOTES.has(r.id) && r.notes?.length ? `<p class="note">${esc(r.notes.at(-1))}</p>` : "";
    return `<tr class="${e.cls}">
      <td class="seq" data-l=""><span class="sid">${esc(r.id)}</span> ${esc(r.title)}${reason}${note}${naiveLine(r)}${mline(r, e)}</td>
      ${cell("Kiosk submissions", String(m.submissions))}
      ${cell("Debits the bank took", String(m.debits))}
      ${cell("Orders at the register", String(m.orders))}
      ${cell("Register shows paid", m.registerPaid)}
      ${cell("Money settled", moneyCell(m))}
      ${cell("Ending", `<span class="end ${e.cls}">${e.label}</span>${m.exposureCents ? `<span class="exp">store short ${usd(m.exposureCents)}</span>` : ""}`)}
    </tr>`;
  }).join("")
}
  </tbody>`).join("");

// ------------------------------------------------------------------ order of operations
const ord = pglite.orderings as Json;
const ordTable = `
<table class="ord">
  <thead><tr><th scope="col">Same fault</th>${ord.strategies.map((s: Json) => `<th scope="col"><span class="sid">${s.id}</span> ${esc(s.title)}</th>`).join("")}</tr></thead>
  <tbody>
  ${
  ord.rows.map((r: Json) =>
    `<tr><th scope="row">${esc(r.title)}</th>${
      ord.strategies.map((s: Json) => {
        const c = r.cells[s.id];
        const bad = c.moneyWithoutPaidOrder || c.unpaidOpenOrders > 0 || /more than the kiosk/.test(c.outcome);
        const text = String(c.outcome).replace(/^[a-z_]+: /, "").replaceAll("_", " ");
        return `<td data-l="${esc(s.id)}" class="${bad ? "red" : ""}">${esc(text)}<span class="dim small">${c.debits} debit${c.debits === 1 ? "" : "s"}, ${c.orders} order${c.orders === 1 ? "" : "s"}${c.unpaidOpenOrders ? `, ${c.unpaidOpenOrders} left unpaid` : ""}</span></td>`;
      }).join("")
    }</tr>`
  ).join("")
}
  </tbody>
</table>`;

// ------------------------------------------------------------------ page
const ranOn = server
  ? `PGlite (Postgres 17.5 in WebAssembly) and a Postgres 18.6 server; the ${totalSeq} sequences gave identical measures on both.`
  : `PGlite (Postgres 17.5 in WebAssembly).`;
const repo = "https://github.com/fred1433/kiosk-payment-check";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title>When kiosk payment and the register disagree</title>
<meta name="description" content="A tested Supabase kiosk module with simulated bank and POS failures, and a dated feasibility note.">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="icon" href="favicon.png" type="image/png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --counter:#E4E6E9; --paper:#FDFDFB; --ink:#1E2227; --faded:#62676F; --rule:#C9CCD1;
  --red:#B5302A; --red-wash:#F7E4E1; --amber:#8A5A00;
  --sans:"Schibsted Grotesk", system-ui, sans-serif; --receipt:"Courier Prime", "Courier New", monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--counter);color:var(--ink);font:400 17px/1.55 var(--sans)}
.num{font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px}
.dim{color:var(--faded)}
.small{font-size:13px}

/* ---------- hero ---------- */
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,660px);gap:48px;padding:52px 0 88px;align-items:start}
.lede{position:sticky;top:40px;padding-top:12px}
h1{font-weight:700;font-size:clamp(34px,4.4vw,54px);line-height:1.04;letter-spacing:-.02em;margin:0 0 22px;max-width:12ch}
.status{font-size:15px;line-height:1.5;color:var(--faded);margin:0 0 28px;max-width:38ch;padding-left:14px;border-left:3px solid var(--ink)}
.lede p.thesis{font-size:19px;line-height:1.55;max-width:34ch;margin:0 0 18px}
.lede .links{font-size:15px;margin-top:28px;display:flex;gap:20px;flex-wrap:wrap}

/* ---------- the receipt ---------- */
.receipt-wrap{margin:0}
.paper{background:var(--paper);font:400 14.5px/1.45 var(--receipt);color:var(--ink);padding:26px 26px 22px;position:relative;
  --tooth:8px;
  -webkit-mask:conic-gradient(from -45deg at bottom,#0000,#000 1deg 89deg,#0000 90deg) bottom/calc(2*var(--tooth)) 51% repeat-x,
               conic-gradient(from 135deg at top,#0000,#000 1deg 89deg,#0000 90deg) top/calc(2*var(--tooth)) 51% repeat-x;
          mask:conic-gradient(from -45deg at bottom,#0000,#000 1deg 89deg,#0000 90deg) bottom/calc(2*var(--tooth)) 51% repeat-x,
               conic-gradient(from 135deg at top,#0000,#000 1deg 89deg,#0000 90deg) top/calc(2*var(--tooth)) 51% repeat-x;
  filter:drop-shadow(0 1px 0 rgba(30,34,39,.08))}
.paper.main{width:min(100%,520px);margin:0 auto;padding-bottom:28px}
.rc-center{text-align:center;margin:0 0 4px;letter-spacing:.04em}
.rule{height:0;border-top:2px dashed var(--rule);margin:14px 0}
.items{list-style:none;margin:0;padding:0}
.items li{display:flex;justify-content:space-between;gap:12px}
.items li.sub{color:var(--faded)}
.items li.tot{font-weight:700;margin-top:6px;font-size:15.5px}
.events{list-style:none;margin:0;padding:0}
.ev{display:grid;grid-template-columns:3.1em 6.8em 1fr;gap:0 6px;padding:3px 0}
.ev .t{color:var(--faded)}
.ev .l{font-weight:700;letter-spacing:.02em}
.ev.unknown .x{color:var(--faded)}
.ev.unknown .l::after{content:" ?";color:var(--red)}
.ev.stop .x,.ev.stop .l{color:var(--red);font-weight:700}
.fork{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:-6px;position:relative;align-items:start}
.fork::before{content:"";position:absolute;left:50%;top:-14px;width:0;height:14px;border-left:2px dashed var(--rule)}
.tail{padding-top:22px}
.tail-h{font-weight:700;margin:0 0 8px;font-size:15px}
.tail.stop .tail-h{color:var(--red)}
.tail .ev{grid-template-columns:3.1em 1fr;font-size:13.5px}
.tail .ev .l{grid-column:2}
.tail .ev .t{grid-row:span 2}
.totals{list-style:none;margin:14px 0 0;padding:12px 0 0;border-top:2px dashed var(--rule)}
.totals li{display:flex;justify-content:space-between;gap:8px;font-weight:700;font-size:13.5px}
.totals li.red{color:var(--red)}
figcaption{font-size:14px;color:var(--faded);margin:18px auto 0;max-width:52ch;text-align:center}

/* ---------- sections ---------- */
section.band{background:var(--paper);padding:84px 0 92px}
section.plain{padding:84px 0 96px}
h2{font-weight:700;font-size:clamp(28px,3.2vw,40px);line-height:1.1;letter-spacing:-.015em;margin:0 0 18px;max-width:22ch}
h3{font-weight:600;font-size:21px;line-height:1.25;margin:56px 0 12px}
.intro{max-width:66ch;margin:0 0 14px}
.boundary{max-width:66ch;font-size:15px;color:var(--faded);margin:0 0 36px}

table{border-collapse:collapse;width:100%}
.bench{font-size:14.5px}
.bench thead th{font-weight:600;font-size:13px;color:var(--faded);text-align:right;padding:0 10px 10px;vertical-align:bottom;border-bottom:2px solid var(--ink)}
.bench thead th:first-child{text-align:left;padding-left:0}
.bench td{padding:12px 10px;border-bottom:1px solid var(--rule);text-align:right;vertical-align:top;white-space:nowrap}
.bench td.seq{text-align:left;white-space:normal;padding-left:0;max-width:430px}
.fam-h th{text-align:left;padding:34px 0 8px;font-size:17px;font-weight:600;border-bottom:1px solid var(--ink)}
.fam:first-of-type .fam-h th{padding-top:18px}
.fn{display:inline-block;min-width:1.4em;color:var(--faded)}
.fam-toggle{all:unset;display:block;width:100%;cursor:pointer}
.fam-toggle:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
.tally{display:none}
.fam.collapsed tr:not(.fam-h){display:none !important}
.dem{display:block;font-weight:400;font-size:14px;color:var(--faded);margin-left:1.4em}
.sid{font-family:var(--receipt);font-weight:700;margin-right:4px}
.reason{margin:6px 0 0;font-size:13.5px;line-height:1.45}
.reason.red{color:var(--red)}
.reason.amber{color:var(--amber)}
.naive{margin:6px 0 0;font-size:13px;color:var(--faded);font-style:italic}
.note{margin:6px 0 0;font-size:13px;color:var(--faded)}
.mline{display:none}
.end{font-weight:600}
.end.red{color:var(--red)}
.end.amber{color:var(--amber)}
tr.red td.seq{box-shadow:inset 3px 0 0 var(--red);padding-left:12px}
.exp{display:block;color:var(--red);font-size:13px}
.mv{font-family:var(--receipt);font-size:13.5px}
.mv.neg{color:var(--red)}

.ord{font-size:14.5px;margin-top:8px}
.ord th,.ord td{text-align:left;vertical-align:top;padding:12px 14px 12px 0;border-bottom:1px solid var(--rule)}
.ord thead th{font-weight:600;font-size:14px;border-bottom:2px solid var(--ink)}
.ord tbody th{font-weight:600;width:22%}
.ord td.red{color:var(--red)}
.ord .small{display:block;margin-top:4px}
.ord-note{max-width:66ch;margin:18px 0 0}

.known{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;margin-top:8px}
.known h3{margin-top:0}
.known ul{margin:0;padding-left:1.1em}
.known li{margin:0 0 8px}
.routes{font-size:14.5px;margin-top:10px}
.routes th,.routes td{text-align:left;vertical-align:top;padding:12px 16px 12px 0;border-bottom:1px solid var(--rule)}
.routes thead th{font-weight:600;font-size:14px;border-bottom:2px solid var(--ink)}
.routes td.block{font-weight:600;white-space:nowrap}
.routes td.block.yes{color:var(--red)}
.src{font-size:13px;color:var(--faded)}
.me{max-width:62ch;font-size:19px;line-height:1.55;margin:56px 0 0;padding:26px 0 0;border-top:2px solid var(--ink)}
.ran{max-width:66ch;font-size:15px}
footer{padding:36px 0 56px;font-size:14px;color:var(--faded)}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}

/* ---------- narrow ---------- */
@media (max-width:980px){
  .hero{grid-template-columns:1fr;gap:40px;padding:44px 0 64px}
  .lede{position:static}
  h1{max-width:14ch}
  .known{grid-template-columns:1fr;gap:32px}
}
@media (max-width:700px){
  body{font-size:16px}
  .wrap{padding:0 16px}
  .hero{gap:28px;padding:32px 0 48px}
  h1{font-size:31px;margin-bottom:16px}
  .status{font-size:13.5px;margin-bottom:18px}
  .lede p.thesis{font-size:16px;margin-bottom:12px}
  .lede .links{margin-top:14px}
  .rc-center{letter-spacing:0}
  .paper{padding:22px 16px 20px;font-size:13.5px}
  .fork{grid-template-columns:1fr;gap:14px}
  .fork::before{display:none}
  .ev{grid-template-columns:2.9em 5.9em 1fr}
  section.band,section.plain{padding:56px 0 64px}
  .bench thead{display:none}
  .bench tbody.fam,.bench tr,.bench th,.bench td.seq{display:block}
  .bench td.num{display:none}
  .bench td.seq{padding:14px 0;border-bottom:1px solid var(--rule);max-width:none}
  tr.red td.seq{box-shadow:none;padding-left:0}
  .mline{display:block !important;margin:8px 0 0;font-size:13.5px;line-height:1.45}
  .mline .exp{display:inline}
  .tally{display:block;font-weight:400;font-size:13.5px;margin:6px 0 0 1.4em}
  .fam-toggle::after{content:"Show";position:absolute;right:0;top:0;font-size:13px;font-weight:600;text-decoration:underline;text-underline-offset:3px}
  .fam-toggle[aria-expanded="true"]::after{content:"Hide"}
  .fam-toggle{position:relative;padding-right:3.2em;box-sizing:border-box}
  .ord thead{display:none}
  .ord tr,.ord th,.ord td{display:block;width:auto}
  .ord tbody th{padding:18px 0 6px;border:0;width:auto}
  .ord td{border:0;padding:4px 0 8px}
  .ord td::before{content:attr(data-l) " ";font-family:var(--receipt);font-weight:700}
  .routes thead{display:none}
  .routes tr,.routes td{display:block}
  .routes td{border:0;padding:3px 0}
  .routes tr{border-bottom:1px solid var(--rule);padding:12px 0}
}
@media (prefers-reduced-motion:no-preference){
  .fork .tail{animation:print .7s cubic-bezier(.2,.7,.2,1) both}
  .fork .tail.stop{animation-delay:.18s}
  @keyframes print{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}
}
</style>
</head>
<body>
<main>
<div class="wrap">
  <header class="hero">
    <div class="lede">
      <h1>When kiosk payment and the register disagree</h1>
      <p class="status">Simulated payment and POS services. Tested orchestration code. Public-source feasibility review dated 28 September 2026. No live payments.</p>
      <p class="thesis">A kiosk checkout attempt, an accepted payment and a completed purchase are not the same event.</p>
      <p class="thesis">Here the bank has taken the money and the call that tells the register times out. The module asks the register what it has before doing anything else. Sometimes the register has it. Sometimes it never will, and staff need to know before the shopper is asked to pay a second time.</p>
      <p class="links"><a href="${repo}">The code and tests</a><a href="#feasibility">The feasibility note</a></p>
    </div>
    ${receipt}
  </header>
</div>

<section class="band" aria-labelledby="bench-h">
  <div class="wrap">
    <h2 id="bench-h">Every failure replayed, measured separately</h2>
    <p class="intro">${totalSeq} sequences in eight families, each on a fresh database against simulated bank and register services. The counts are what the simulated bank and register actually did, not what the code believes. ${personEndings} sequences end with a person deciding: for them, stopping is the correct result.</p>
    <p class="intro">A naive version runs against the same faults: debit first, then the order, and a fresh key and a fresh order id on every retry. It passes a happy-path demo; its results sit under each sequence it applies to. As a check on the bench itself, changing the module to send a fresh key on retry turns three sequences red.</p>
    <p class="boundary">The tests verify this module against the stated simulated contracts. They do not certify provider behavior or prevent independent cashier actions. The register side is a contract-shaped simulator of Cova's public Sales Order API, not a certified integration.</p>
    <table class="bench">
      <thead><tr><th scope="col">Sequence</th><th scope="col">Kiosk submissions</th><th scope="col">Debits the bank took</th><th scope="col">Orders at the register</th><th scope="col">Register shows paid</th><th scope="col">Money settled</th><th scope="col">Ending</th></tr></thead>
      ${benchRows}
    </table>

    <h3>Which comes first, the debit or the order</h3>
    <p class="intro">The same faults, run against three orders of operations. A and B are minimal flows written for this comparison; C is the module above.</p>
    ${ordTable}
    <p class="ord-note">No order is safe on its own. C is chosen on two assumptions to confirm with the provider: preauthorization without funds movement, and capture of at most the preauthorized amount. What C introduces is the window between the capture and the register showing the order paid. That window is what the first screen of this page is about, and it is surfaced, never marked complete.</p>
  </div>
</section>

<section class="plain" id="feasibility" aria-labelledby="known-h">
  <div class="wrap">
    <h2 id="known-h">What is known, and what is not</h2>
    <p class="intro">From public documentation read on 28 September 2026. Not provider approval and not a live test. The full note, with sources for every line, is in the repository: <a href="${repo}/blob/main/docs/discovery-note.md">docs/discovery-note.md</a>.</p>
    <table class="routes">
      <thead><tr><th scope="col">Question</th><th scope="col">What the public source establishes</th><th scope="col">Still open</th><th scope="col">Blocks a pilot</th></tr></thead>
      <tbody>
        <tr><td>Aeropay, embedded</td><td>White-label user creation by API; preauthorized transactions that move no funds until captured. <span class="src">dev.aero.inc</span></td><td>Recovery: for several return codes its help center sends the shopper to log in to Aeropay. Platform structure: its terms bar initiating transactions for others. Written position on licensed THC retail: its cannabis page now redirects to "specialized retail".</td><td class="block yes">Yes, until answered in writing</td></tr>
        <tr><td>Aeropay, fee and returns</td><td>Consumer fee capped at what Aeropay charges the merchant; a non-guaranteed ACH option has the merchant reimburse all returns. <span class="src">Aeropay merchant terms</span></td><td>Which product a pilot would be on, and who is debited for a return.</td><td class="block yes">Yes, for the fee design</td></tr>
        <tr><td>CanPay RemotePay</td><td>Prepayment in merchants' apps by one-click payment or guest checkout; merchants can adjust amounts; kiosks listed. <span class="src">canpaydebit.com</span></td><td>Saved reference tied to the kiosk platform's shopper profile, returning shoppers, recovery, access for a platform, fees.</td><td class="block">Unknown</td></tr>
        <tr><td>Dutchie Pay by Bank</td><td>No funds reimbursement: a void or return in the POS does not reverse the payment; refunds in cash or store credit. <span class="src">Dutchie support</span></td><td>Whether a third-party kiosk can use it at all.</td><td class="block">For a Dutchie store</td></tr>
        <tr><td>Paid at the kiosk, seen at the register</td><td>Cova: CovaOrderPayment, amount must equal the sale total, paid orders cannot be cancelled. Dutchie: a preorder's payment happens at pickup; idempotency needs both ConsumerKey and IdempotencyKey. <span class="src">Cova API portal, Dutchie POS swagger</span></td><td>How each register shows a kiosk-paid order to the cashier, and whether a repeated submit or payment record is deduplicated.</td><td class="block yes">Yes</td></tr>
        <tr><td>ACH timing</td><td>Most returns within 2 banking days of settlement; consumer unauthorized returns (R05, R07, R10, R11) within 60 days; a refunded debit can still be returned, debiting the merchant twice. <span class="src">Plaid</span></td><td>Who bears it, by contract. Which party holds the 2026 Nacha fraud-monitoring duties.</td><td class="block">No, but shapes the staff screen</td></tr>
      </tbody>
    </table>

    <div class="known" style="margin-top:56px">
      <div>
        <h3>Built and tested here</h3>
        <ul>
          <li>Postgres schema with payment, money movements, order, register acknowledgment and handoff kept apart, and a reconciliation view.</li>
          <li>Short-transaction durable operations: claim, call outside any transaction, record with a claim token; same key on every retry.</li>
          <li>Signed webhook ingestion, deduplicated by event and by fact; polling for missing webhooks.</li>
          <li>The eight failure families above, the naive baseline, and the order-of-operations comparison.</li>
          <li>Database roles: browser roles read and call nothing.</li>
        </ul>
      </div>
      <div>
        <h3>To research before any price</h3>
        <ul>
          <li>The payment route, in writing, for this state, this kiosk and this platform structure.</li>
          <li>How the pilot register records a kiosk payment the cashier can see.</li>
          <li>Recovery and reconnection without a provider login.</li>
          <li>Fee permissions and return liability under the actual agreement.</li>
          <li>The existing repository, its adapters and its contracts.</li>
        </ul>
      </div>
    </div>

    <h3>Where it ran</h3>
    <p class="ran">Measures on this page: ${esc(ranOn)} Concurrency, restart recovery, lease fencing and roles: Postgres 18.6 server only (5 tests). The Edge Function's HTTP handler: tested under Deno ${esc(String(pglite.runtime).replace("Deno ", ""))}, not in the Supabase Edge runtime, which was not run. Nothing was deployed to Supabase. This page is static and says nothing about the backend.</p>

    <p class="me">I built and tested this work sample. I have not built a production ACH system. It demonstrates the failure-handling approach, not a production payment track record. The next step I would propose is a small paid discovery milestone that ends with a route decision and acceptance criteria, including the possible answer that no route meets the requirement yet.</p>
  </div>
</section>
</main>
<script>
  // Families are open on wide screens and folded on phones; each heading toggles its rows.
  document.querySelectorAll(".fam").forEach((tb) => {
    const b = tb.querySelector(".fam-toggle");
    const set = (open) => { tb.classList.toggle("collapsed", !open); b.setAttribute("aria-expanded", String(open)); };
    set(!matchMedia("(max-width: 700px)").matches);
    b.addEventListener("click", () => set(tb.classList.contains("collapsed")));
  });
</script>
<footer>
  <div class="wrap">
    <span>Frederic de Lavenne de Choulot, The AI Pipe</span>
    <span><a href="${repo}">Repository</a> &nbsp; <a href="https://cal.theaipipe.com">15 minutes to talk</a></span>
  </div>
</footer>
</body>
</html>`;

// Served at https://theaipipe.com/kiosk-payments/ by a Worker with static assets (wrangler.toml).
const out = new URL("dist/kiosk-payments/", root);
await Deno.mkdir(out, { recursive: true });
await Deno.writeTextFile(new URL("index.html", out), html);
for (const f of ["favicon.svg", "favicon.png", "apple-touch-icon.png"]) await Deno.copyFile(new URL(f, root), new URL(f, out));
await Deno.writeTextFile(
  new URL("dist/_headers", root),
  "/kiosk-payments/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n",
);
if (html.includes("—")) throw new Error("em dash in page");
console.log(`built site/dist/kiosk-payments/index.html (${html.length} bytes), server agreement: ${sameOnServer}`);

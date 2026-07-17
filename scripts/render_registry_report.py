#!/usr/bin/env python3
#
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
"""Render the Maven 4 adoption registry (maven4-registry.json) to a static
HTML report. Reads the re-examination records (state, signal, Maven runtime,
build) and emits a self-contained page with summary cards, stat tables, a
collapsible legend and Excel-style checkbox filters.

Usage: render_registry_report.py <registry.json> <output.html>
"""
import json, html, sys, datetime
from collections import Counter
from pathlib import Path

IN = Path(sys.argv[1] if len(sys.argv) > 1 else "data/maven4-registry.json")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "public/maven4-adoption.html")
_raw = json.loads(IN.read_text())
# schema 1 registry object, or the legacy bare list
FINAL = _raw['repos'] if isinstance(_raw, dict) else _raw
recon = _raw.get('reconciliation') if isinstance(_raw, dict) else None
def esc(x): return html.escape(str(x if x is not None else ''))

for f in FINAL:
    f['_sig'] = f.get('live_signal') or 'none'
    f['_runtime'] = f.get('live_version') or 'none'
    f['_build'] = (f.get('build') or 'NONE').upper()

confirmed = [f for f in FINAL if f.get('live_signal')]
active_n = sum(1 for f in FINAL if f['state'] == 'active')
arch = sum(1 for f in FINAL if f['state'] == 'archived')
gone = sum(1 for f in FINAL if f['state'] == 'gone')
alive_n = active_n + arch
dark_n = sum(1 for f in FINAL if f['state'] == 'active' and not f.get('live_signal'))

vers = Counter(f['live_version'] for f in confirmed if f.get('live_version'))
sigs = Counter(f['live_signal'] for f in confirmed)
builds = Counter(f['_build'] for f in confirmed)
GREEN = {'SUCCESS'}; RED = {'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT'}
green = sum(v for k, v in builds.items() if k in GREEN)
red = sum(v for k, v in builds.items() if k in RED)

state_c = Counter(f['state'] for f in FINAL)
sig_c = Counter(f['_sig'] for f in FINAL)
run_c = Counter(f['_runtime'] for f in FINAL)
build_c = Counter(f['_build'] for f in FINAL)

BC = {'SUCCESS':'#2a7','FAILURE':'#c33','STARTUP_FAILURE':'#c33','TIMED_OUT':'#c33','AMBIGUOUS':'#a80',
      'ACTION_REQUIRED':'#a80','SKIPPED':'#888','CANCELLED':'#888','IN_PROGRESS':'#39c',
      'QUEUED':'#39c','NONE':'#bbb','UNKNOWN':'#bbb','NEUTRAL':'#888'}
SC = {'active':'#2a7','archived':'#a80','gone':'#c33'}

def checks(cls, counter, order=None):
    items = order or [k for k, _ in counter.most_common()]
    out = []
    for k in items:
        if k not in counter: continue
        out.append(f"<label><input type=checkbox class='f-{cls}' value=\"{esc(k)}\" onchange=flt()> "
                   f"{esc(k)} <span class=ct>{counter[k]}</span></label>")
    return "".join(out)

now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

rows = []
for f in sorted(FINAL, key=lambda x: (x.get('live_signal') is None, -int(x.get('stars') or 0))):
    bcol = BC.get(f['_build'], '#888')
    btitle = f" title=\"{esc(f.get('build_workflow'))}\"" if f.get('build_workflow') else ''
    build_cell = (f"<a href='{esc(f.get('build_url'))}' target=_blank rel=noreferrer style='color:{bcol}'{btitle}>{esc(f['_build'])}</a>"
                  if f.get('build_url') else f"<span style='color:{bcol}'{btitle}>{esc(f['_build'])}</span>")
    src = f.get('source') or ''
    srctag = 'root' if src == 'root' else ('nested' if src.startswith('nested') else '')
    dark = ''
    if f['state'] == 'active' and not f.get('live_signal'):
        dark = f"last-known: {esc(f.get('lastknown_signal'))} {esc(f.get('lastknown_version'))}"
    rows.append(
        f"<tr data-state=\"{esc(f['state'])}\" data-sig=\"{esc(f['_sig'])}\" "
        f"data-runtime=\"{esc(f['_runtime'])}\" data-build=\"{esc(f['_build'])}\">"
        f"<td><a href='https://github.com/{esc(f['repo'])}' target=_blank rel=noreferrer>{esc(f['repo'])}</a>"
        f"{(' → '+esc(f.get('renamed_to'))) if f.get('renamed_to') else ''}</td>"
        f"<td><span style='color:{SC.get(f['state'],'#888')}'>●</span> {esc(f['state'])}</td>"
        f"<td style='text-align:right'>{esc(f.get('stars'))}</td>"
        f"<td>{esc(f.get('pushed_at'))}</td>"
        f"<td>{esc(f.get('live_signal') or '')}</td>"
        f"<td>{esc(f.get('live_version') or '')}</td>"
        f"<td style='color:#888'>{srctag}</td>"
        f"<td>{build_cell}</td>"
        f"<td style='color:#a80;font-size:12px'>{dark}</td></tr>")

def stat_tbl(counter):
    return "".join(f"<tr><td>{esc(k)}</td><td style='text-align:right'>{v}</td></tr>" for k, v in counter.most_common())

# mouse-over explanations, derived from the legend entries
TIP = {
    'repo': 'GitHub repository (owner/name); an arrow marks a detected rename',
    'state': 'active = repo reachable / archived = read-only (adoption frozen) / gone = deleted, private or inaccessible. Not a Maven 4 signal.',
    'stars': 'GitHub stargazer count',
    'pushed': 'Date of the most recent push to the default branch — tells active projects apart from dormant ones. Not a Maven 4 signal.',
    'signal': 'Which Maven 4 detection signal is present: POM 4.1.0 (a pom.xml with the new namespace), Wrapper (a maven-wrapper.properties referencing apache-maven-4), GH Action (a workflow installing Maven 4)',
    'runtime': 'Maven CLI version pinned in the wrapper or workflow (e.g. 4.0.0-rc-5); 4.1.0 (POM model) for POM-only repos',
    'src': 'Where the signal was found on re-examination: root (root pom.xml/.mvn) or nested (below the repo root, via git-tree walk)',
    'build': 'Conclusion of the most recent completed run, on the default branch, of a workflow that actually invokes Maven (mvn/mvnw or setup-java). AMBIGUOUS = several Maven workflows disagree (hover the cell for the breakdown). NONE = no Maven-invoking workflow with a completed default-branch run. Not a Maven 4 signal.',
    'lastknown': 'For a signal-not-found active repo: the signal/runtime last recorded in the CI artifacts, to aid triage of possible reverts',
    'tracked': 'Every repo ever seen by discovery, kept forever: active + archived + gone',
    'active': 'Repo reachable and not archived',
    'archived': 'Read-only on GitHub — adoption state frozen',
    'gone': 'Deleted, private or otherwise inaccessible',
    'confirmed': 'Reachable repos with a live Maven 4 signal (POM 4.1.0, Wrapper or GH Action)',
    'green': 'Confirmed adopters whose last completed default-branch Maven workflow run succeeded',
    'red': 'Confirmed adopters whose last completed default-branch Maven workflow run failed, had a startup failure or timed out',
    'dark': 'Active repos where no signal is currently locatable (likely reverted, or a truncated git tree)',
}
def tip(k): return f' title="{esc(TIP[k])}"'

recon_html = ""
if recon:
    recon_html = (f"<div class=recon>🔄 Last full reconciliation {esc(recon.get('date'))}: "
                  f"+{esc(recon.get('missed', 0))} adopters the incremental scan had missed "
                  f"(investigate if this grows).</div>")

doc = f"""<!doctype html><meta charset=utf-8>
<title>Maven 4 Adoption — Registry</title>
<style>
 body{{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1c1c1c;max-width:1180px}}
 h1{{margin-bottom:.2rem}} .sub{{color:#666;margin-top:0}}
 .cards{{display:flex;gap:.8rem;flex-wrap:wrap;margin:.3rem 0 1rem}}
 .card{{border:1px solid #ddd;border-radius:8px;padding:.5rem .9rem;min-width:110px}}
 .card b{{font-size:1.6rem;display:block}}
 .grouplbl{{margin:.9rem 0 .1rem;font-weight:600;color:#333}}
 .eq{{font-weight:400;color:#888;font-size:12px}}
 .two{{display:flex;gap:2rem;flex-wrap:wrap}}
 table{{border-collapse:collapse;margin:.5rem 0}} #t{{width:100%}}
 th,td{{border-bottom:1px solid #eee;padding:4px 8px;text-align:left;vertical-align:top}}
 #t th{{cursor:pointer;background:#fafafa;position:sticky;top:0}}
 .note{{background:#eef6ff;border-left:3px solid #3b82c4;padding:.6rem 1rem;border-radius:4px}}
 .recon{{background:#fff8e6;border-left:3px solid #e0a800;padding:.5rem 1rem;border-radius:4px;margin:.6rem 0}}
 details{{margin:1rem 0}} summary{{cursor:pointer;font-weight:600}}
 dl.legend dt{{font-weight:600;margin-top:.5rem}} dl.legend dd{{margin:0 0 .1rem 0;color:#444}}
 code{{background:#f2f2f2;padding:0 3px;border-radius:3px}}
 .filters{{display:flex;gap:1.2rem;flex-wrap:wrap;align-items:flex-start;border:1px solid #e3e3e3;border-radius:8px;padding:.7rem 1rem;margin:1rem 0}}
 .fg{{display:flex;flex-direction:column}} .fg > b{{font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.03em}}
 .fg .box{{max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:1px;margin-top:3px}}
 .fg label{{font-size:13px;white-space:nowrap}} .ct{{color:#999;font-size:11px}}
 .fbar{{display:flex;gap:.6rem;align-items:center;margin-bottom:.4rem}}
 input[type=search]{{padding:5px 8px;min-width:220px}} button{{padding:4px 10px}}
 #topnav{{position:sticky;top:0;z-index:20;background:#fffffff2;backdrop-filter:blur(2px);
  border-bottom:1px solid #e3e3e3;margin:0 -2rem .8rem;padding:.45rem 2rem;font-size:13px}}
 #topnav a{{color:#3b62c4;text-decoration:none;margin-right:.9rem}}
 #topnav a:hover{{text-decoration:underline}}
 #topnav .lbl{{color:#888;margin-right:.6rem}}
 section{{scroll-margin-top:3rem}}
 #toc{{display:none}}
 @media(min-width:1420px){{
  body{{margin-left:210px}}
  #toc{{display:block;position:fixed;top:5rem;left:1rem;width:150px;font-size:13px;
   border-left:2px solid #e3e3e3;padding-left:.8rem;line-height:2}}
  #toc a{{display:block;color:#777;text-decoration:none;border-left:2px solid transparent;
   margin-left:calc(-.8rem - 2px);padding-left:.8rem}}
  #toc a:hover{{color:#1c1c1c}}
  #toc a.cur{{color:#1c1c1c;font-weight:600;border-left-color:#3b62c4}}
 }}
</style>
<h1>Maven 4 Adoption — Registry</h1>
<p class=sub>Generated {now}</p>
<nav id=topnav><span class=lbl>Jump to:</span><a href=#summary>Summary</a><a href=#statistics>Statistics</a><a href=#projects><b>Projects</b></a></nav>
<nav id=toc aria-label="Contents">
 <a href=#summary>Summary</a>
 <a href=#statistics>Statistics</a>
 <a href=#projects>Projects</a>
</nav>
{recon_html}
<section id=summary>
<p class=grouplbl>Registry state <span class=eq>({len(FINAL)} = active + archived + gone)</span></p>
<div class=cards>
 <div class=card{tip('tracked')}><b>{len(FINAL)}</b>tracked (union)</div>
 <div class=card{tip('active')}><b style='color:#2a7'>{active_n}</b>active</div>
 <div class=card{tip('archived')}><b style='color:#a80'>{arch}</b>archived</div>
 <div class=card{tip('gone')}><b style='color:#c33'>{gone}</b>gone</div>
</div>
<p class=grouplbl>Maven 4 &amp; CI <span class=eq>(among the {alive_n} reachable)</span></p>
<div class=cards>
 <div class=card{tip('confirmed')}><b>{len(confirmed)}</b>confirmed M4 signal</div>
 <div class=card{tip('green')}><b style='color:#2a7'>{green}</b>CI green</div>
 <div class=card{tip('red')}><b style='color:#c33'>{red}</b>CI failing</div>
 <div class=card{tip('dark')}><b style='color:#bbb'>{dark_n}</b>signal not found</div>
</div>

<div class=note><b>Method:</b> Maven 4 adopters are <b>discovered</b> via GitHub code search and then
<b>permanently tracked</b>: every repo ever seen is kept in a candidate registry and <b>re-examined live</b>
on each run (existence, signal, Maven runtime, build) — instead of depending on a single, rate-limit-flaky
daily search. Signals below the repo root are resolved via a git-tree walk. This snapshot: {len(FINAL)}
candidates, of which {alive_n} reachable and {len(confirmed)} with a confirmed signal; {dark_n} active
repos with no locatable signal (likely reverted, or a truncated tree). The statistics below cover the
{len(confirmed)} confirmed adopters.</div>
</section>

<section id=statistics>
<div class=two>
 <div><h3{tip('signal')}>Signals</h3><table><tr><th{tip('signal')}>Signal</th><th>Count</th></tr>{stat_tbl(sigs)}</table></div>
 <div><h3{tip('runtime')}>Maven Runtime</h3><table><tr><th{tip('runtime')}>Maven Runtime</th><th>Count</th></tr>{stat_tbl(vers)}</table></div>
 <div><h3{tip('build')}>Last Build</h3><table><tr><th{tip('build')}>Last Build</th><th>Count</th></tr>{stat_tbl(builds)}</table></div>
</div>
</section>

<section id=projects>
<h2>Repositories ({len(FINAL)})</h2>
<details><summary>Legend</summary>
<dl class=legend>
 <dt>State</dt><dd><code>active</code> repo reachable · <code>archived</code> read-only (adoption frozen) · <code>gone</code> deleted/private/inaccessible. <em>Not a Maven 4 signal.</em></dd>
 <dt>Signal</dt><dd>Which Maven 4 detection signal is present: <code>POM 4.1.0</code> (a <code>pom.xml</code> with the new namespace), <code>Wrapper</code> (a <code>maven-wrapper.properties</code> referencing <code>apache-maven-4</code>), <code>GH Action</code> (a workflow installing Maven 4).</dd>
 <dt>Maven Runtime</dt><dd>Maven CLI version pinned in the wrapper or workflow (e.g. <code>4.0.0-rc-5</code>); <code>4.1.0 (POM model)</code> for POM-only repos.</dd>
 <dt>Src</dt><dd>Where the signal was found on re-examination: <code>root</code> (root <code>pom.xml</code>/<code>.mvn</code>) or <code>nested</code> (below the repo root, via git-tree walk).</dd>
 <dt>Pushed</dt><dd>Date of the most recent push to the default branch — tells active projects apart from dormant ones. <em>Not a Maven 4 signal.</em></dd>
 <dt>Last Build</dt><dd>Conclusion of the most recent <em>completed</em> run, on the <em>default branch</em>, of a workflow that actually invokes Maven (<code>mvn</code>/<code>mvnw</code> or <code>setup-java</code>). <code>AMBIGUOUS</code> = several Maven workflows disagree and we cannot tell which one is the Maven-4-relevant build — the link goes to the repo's Actions view (hover for the breakdown). <code>NONE</code> = no Maven-invoking workflow with a completed default-branch run. <em>Not a Maven 4 signal.</em></dd>
 <dt>Last-known</dt><dd>For a "signal not found" active repo: the signal/runtime last recorded in the CI artifacts, to aid triage of possible reverts.</dd>
</dl>
</details>
<div class=fbar>
 <input type=search id=q placeholder='search repo…' oninput=flt()>
 <button onclick=clearf()>clear filters</button>
 <span id=shown class=sub></span>
</div>
<div class=filters>
 <div class=fg><b>State</b><div class=box>{checks('state', state_c, ['active','archived','gone'])}</div></div>
 <div class=fg><b>Signal</b><div class=box>{checks('sig', sig_c, ['Wrapper','POM 4.1.0','GH Action','none'])}</div></div>
 <div class=fg><b>Maven Runtime</b><div class=box>{checks('runtime', run_c)}</div></div>
 <div class=fg><b>Last Build</b><div class=box>{checks('build', build_c)}</div></div>
</div>
<table id=t><thead><tr>
 <th onclick=srt(0){tip('repo')}>Repository</th><th onclick=srt(1){tip('state')}>State</th><th onclick=srt(2){tip('stars')}>Stars</th>
 <th onclick=srt(3){tip('pushed')}>Pushed</th><th onclick=srt(4){tip('signal')}>Signal</th><th onclick=srt(5){tip('runtime')}>Maven Runtime</th>
 <th onclick=srt(6){tip('src')}>Src</th><th onclick=srt(7){tip('build')}>Last Build</th><th{tip('lastknown')}>Last-known (if dark)</th></tr></thead>
<tbody>
{''.join(rows)}
</tbody></table>
</section>
<script>
 // scroll-spy for the right-rail contents list
 const tocLinks=[...document.querySelectorAll('#toc a')];
 const spy=new IntersectionObserver(es=>{{
  for(const e of es) if(e.isIntersecting){{
   tocLinks.forEach(a=>a.classList.toggle('cur',a.hash==='#'+e.target.id));
  }}
 }},{{rootMargin:'-10% 0px -70% 0px'}});
 document.querySelectorAll('section[id]').forEach(s=>spy.observe(s));
</script>
<script>
 const tb=document.querySelector('#t tbody');
 const groups=['state','sig','runtime','build'];
 function flt(){{
  const q=document.getElementById('q').value.toLowerCase();
  const checked={{}};
  groups.forEach(g=>checked[g]=[...document.querySelectorAll('.f-'+g+':checked')].map(c=>c.value));
  let n=0;
  for(const tr of tb.rows){{
   let ok=(!q||tr.cells[0].textContent.toLowerCase().includes(q));
   for(const g of groups){{ if(ok&&checked[g].length) ok=checked[g].includes(tr.dataset[g]); }}
   tr.style.display=ok?'':'none'; if(ok)n++;
  }}
  document.getElementById('shown').textContent=n+' / '+tb.rows.length+' shown';
 }}
 function clearf(){{document.querySelectorAll('.filters input').forEach(c=>c.checked=false);document.getElementById('q').value='';flt();}}
 function srt(i){{
  const rows=[...tb.rows].filter(r=>r.style.display!=='none');const num=(i==2);
  rows.sort((a,b)=>{{let x=a.cells[i].textContent.trim(),y=b.cells[i].textContent.trim();
   return num?(+y.replace(/\\D/g,'')||0)-(+x.replace(/\\D/g,'')||0):x.localeCompare(y);}});
  rows.forEach(r=>tb.appendChild(r));
 }}
 flt();
</script>
"""
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(doc)
print(f"Rendered {len(FINAL)} repos -> {OUT}")

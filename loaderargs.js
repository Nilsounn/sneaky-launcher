// MCLC ignore "arguments.jvm" du JSON de version : NeoForge a pourtant besoin de son module path,
// de --add-modules / --add-opens, etc. On les lit ici et on les passe à MCLC via customArgs.
const fs = require('fs');
const path = require('path');

function jvmArgs(versionJsonPath, vars, osName = 'windows') {
  let j;
  try { j = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8')); } catch { return []; }
  const raw = (j.arguments && j.arguments.jvm) || [];
  const allowed = (rules) => {
    if (!rules) return true;
    let ok = false;
    for (const r of rules) {
      if (r.features) continue;
      const m = !r.os || ((!r.os.name || r.os.name === osName) && (!r.os.arch || r.os.arch === 'x64' || r.os.arch === 'amd64'));
      if (m) ok = r.action === 'allow';
    }
    return ok;
  };
  const tokens = [];
  for (const a of raw) {
    if (typeof a === 'string') tokens.push(a);
    else if (allowed(a.rules)) tokens.push(...(Array.isArray(a.value) ? a.value : [a.value]));
  }
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-cp' || t === '-classpath') { i++; continue; }      // le classpath est géré par MCLC
    if (t.startsWith('-Djava.library.path')) continue;              // idem pour les natives
    out.push(t.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
  }
  const bad = out.find((t) => /\$\{\w+\}/.test(t));
  if (bad) throw new Error('Argument JVM non résolu : ' + bad);
  return out;
}
module.exports = { jvmArgs };

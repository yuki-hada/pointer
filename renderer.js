'use strict';

const { ipcRenderer } = require('electron');

// NGL was loaded as a browser UMD in <head>, so it lives on window.NGL
const NGL = window.NGL;

// ── State ──────────────────────────────────────────────────────────────────
let stage     = null;
let component = null;
let currentSchemeId = null;
let chains    = new Map();          // chainId → [{chain, resno, name3}]
let mutationResidues = new Map();   // "C:N" → {chain, resno, name3}
let fixedResidues    = new Map();
let selectionMode    = 'mutation';  // 'mutation' | 'fixed'
let suppressInputSync = false;
let showChainPrefix  = false;       // whether to include "A:" in comma lists
let useSeqIndex      = false;       // use 1-based structural index instead of PDB resno

// Sequential index maps (rebuilt on file load)
let seqIndexMap   = new Map(); // "chain:resno"  → 1-based seq index within chain
let seqIndexToRes = new Map(); // "chain:seqidx" → {chain, resno, name3}

// Drag-select state (rubber-band range)
let isDragging     = false;
let dragAction     = null;   // 'add' | 'remove'
let dragChain      = null;
let dragStartResno = null;
let preDragMut     = null;   // snapshot before drag begins
let preDragFix     = null;

// Chain color palette (unselected residues)
const CHAIN_PALETTE = [
  0x99bbcc,  // A – steel blue
  0x88cc88,  // B – sage green
  0xddaa66,  // C – warm amber
  0xcc88aa,  // D – rose
  0xaaaadd,  // E – lavender
  0x66ccbb,  // F – teal
  0xddcc88,  // G – gold
  0xbb99cc,  // H – lilac
];
let chainColorIndex = new Map(); // chainId → palette index

// Three-letter → one-letter amino acid codes
const AA3to1 = {
  ALA:'A', ARG:'R', ASN:'N', ASP:'D', CYS:'C',
  GLN:'Q', GLU:'E', GLY:'G', HIS:'H', ILE:'I',
  LEU:'L', LYS:'K', MET:'M', PHE:'F', PRO:'P',
  SER:'S', THR:'T', TRP:'W', TYR:'Y', VAL:'V',
  HSD:'H', HSE:'H', HSP:'H', MSE:'M', SEC:'U',
};

// ── PDB parsing ─────────────────────────────────────────────────────────────
function parsePDB(content) {
  const seen = new Map(); // "C:N" → {chain, resno, name3}

  for (const line of content.split('\n')) {
    const rec = line.substring(0, 6).trim();
    if (rec !== 'ATOM' && rec !== 'HETATM') continue;

    const atomName = line.substring(12, 16).trim();
    if (atomName !== 'CA') continue;          // one entry per residue

    const chain  = line[21] || 'A';
    const resno  = parseInt(line.substring(22, 26));
    const name3  = line.substring(17, 20).trim();

    if (isNaN(resno)) continue;

    const key = `${chain}:${resno}`;
    if (!seen.has(key)) seen.set(key, { chain, resno, name3 });
  }

  const chainMap = new Map();
  for (const [, res] of seen) {
    if (!chainMap.has(res.chain)) chainMap.set(res.chain, []);
    chainMap.get(res.chain).push(res);
  }
  for (const [, residues] of chainMap) {
    residues.sort((a, b) => a.resno - b.resno);
  }
  return chainMap;
}

// ── NGL Stage ───────────────────────────────────────────────────────────────
function initStage() {
  stage = new NGL.Stage('ngl-viewport', {
    backgroundColor: '#1a2035',
    quality: 'medium',
  });

  window.addEventListener('resize', () => stage.handleResize());

  // Click on atom → toggle residue in current mode
  stage.signals.clicked.add((proxy) => {
    if (!proxy?.atom) return;
    const chain = proxy.atom.chainname || 'A';
    const resno = proxy.atom.resno;
    toggleResidue(chain, resno);
  });
}

// ── Representation updates ──────────────────────────────────────────────────
function nglSelection(map) {
  if (map.size === 0) return null;
  return [...map.values()]
    .map(({ chain, resno }) => `(${resno} and :${chain})`)
    .join(' or ');
}

function updateNGL() {
  if (!component) return;

  component.removeAllRepresentations();

  // Remove previous scheme to avoid registry leak
  if (currentSchemeId) {
    NGL.ColormakerRegistry.removeScheme(currentSchemeId);
  }

  // Single-pass color scheme: mutation=orange, fixed=blue, else=gray
  currentSchemeId = NGL.ColormakerRegistry.addScheme(function () {
    this.atomColor = (atom) => {
      const key = `${atom.chainname}:${atom.resno}`;
      if (mutationResidues.has(key)) return 0xff6600;
      if (fixedResidues.has(key))    return 0x3388ff;
      const ci = chainColorIndex.get(atom.chainname) ?? 0;
      return CHAIN_PALETTE[ci % CHAIN_PALETTE.length];
    };
  });

  // Ribbon (cartoon) – one representation covers everything
  component.addRepresentation('cartoon', { colorScheme: currentSchemeId });

  // Sidechain licorice for selected residues
  const mutSel = nglSelection(mutationResidues);
  if (mutSel) {
    component.addRepresentation('licorice', {
      sele: mutSel, colorScheme: currentSchemeId, multipleBond: 'symmetric',
    });
  }

  const fixSel = nglSelection(fixedResidues);
  if (fixSel) {
    component.addRepresentation('licorice', {
      sele: fixSel, colorScheme: currentSchemeId, multipleBond: 'symmetric',
    });
  }
}

// ── Sequence panel ──────────────────────────────────────────────────────────
function residueBoxClass(chain, resno) {
  const key = `${chain}:${resno}`;
  if (mutationResidues.has(key)) return 'mutation';
  if (fixedResidues.has(key))    return 'fixed';
  return '';
}

// Update a single box's class + style without rebuilding the whole panel
function refreshBox(chain, resno) {
  const el = document.querySelector(
    `.residue-box[data-chain="${chain}"][data-resno="${resno}"]`
  );
  if (!el) return;
  const cls = residueBoxClass(chain, resno);
  el.className = `residue-box ${cls}`;
  if (cls) {
    el.removeAttribute('style');   // let CSS class handle color
  } else {
    const ci  = chainColorIndex.get(chain) ?? 0;
    const hex = CHAIN_PALETTE[ci % CHAIN_PALETTE.length].toString(16).padStart(6, '0');
    el.style.color = '#' + hex;    // restore chain color
  }
}

function renderSequence() {
  const area = document.getElementById('sequence-area');

  if (chains.size === 0) {
    area.innerHTML = '<div style="color:#445;font-size:12px;text-align:center;padding-top:40px">Open a PDB file to get started</div>';
    return;
  }

  let html = '';
  for (const [chainId, residues] of chains) {
    const ci    = chainColorIndex.get(chainId) ?? 0;
    const hex   = CHAIN_PALETTE[ci % CHAIN_PALETTE.length].toString(16).padStart(6, '0');
    const color = '#' + hex;

    html += `<div class="chain-section">
      <div class="chain-label" style="color:${color}">Chain ${chainId} (${residues.length} aa)</div>
      <div class="sequence-row">`;

    for (let i = 0; i < residues.length; i++) {
      const { chain, resno, name3 } = residues[i];
      const cls      = residueBoxClass(chain, resno);
      const lett     = AA3to1[name3] ?? '?';
      const boxStyle = cls ? '' : `style="color:${color}"`;

      // Position label every 10 residues – always emit div to keep row height uniform
      const seqIdx       = i + 1;
      const dispNum      = useSeqIndex ? seqIdx : resno;
      const isGroupStart = (i % 10 === 0);
      const posText      = isGroupStart ? dispNum : '';

      html += `<div class="residue-wrap">
        <div class="res-pos">${posText}</div>
        <div class="residue-box ${cls}" ${boxStyle}
             data-chain="${chain}" data-resno="${resno}" data-name3="${name3}">${lett}</div>
      </div>`;
    }

    html += '</div></div>';
  }

  area.innerHTML = html;
  attachSequenceEvents(area);
}

function setStatus(text) {
  document.getElementById('residue-status').textContent = text;
}

function attachSequenceEvents(area) {
  // Mouseover → status bar
  area.addEventListener('mouseover', (e) => {
    const box = e.target.closest('.residue-box');
    if (box) {
      const { name3, chain } = box.dataset;
      const resno = parseInt(box.dataset.resno);
      const si    = seqIndexMap.get(`${chain}:${resno}`) ?? '?';
      setStatus(`${name3} (${AA3to1[name3] ?? '?'})  ·  Chain ${chain}  ·  PDB# ${resno}  ·  seq# ${si}`);
    }
  });
  area.addEventListener('mouseleave', () => setStatus(''));

  area.querySelectorAll('.residue-box').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const chain = el.dataset.chain;
      const resno = parseInt(el.dataset.resno);
      const key   = `${chain}:${resno}`;

      dragChain      = chain;
      dragStartResno = resno;
      preDragMut     = new Map(mutationResidues);
      preDragFix     = new Map(fixedResidues);
      dragAction     = (selectionMode === 'mutation' ? mutationResidues : fixedResidues).has(key)
                       ? 'remove' : 'add';
      isDragging     = true;

      applyDragRange(resno);
    });

    el.addEventListener('mouseover', () => {
      if (!isDragging) return;
      if (el.dataset.chain !== dragChain) return;  // same chain only
      applyDragRange(parseInt(el.dataset.resno));
    });
  });
}

// Rubber-band range selection: restore pre-drag state, then apply [start..end]
function applyDragRange(currentResno) {
  const list = chains.get(dragChain) ?? [];
  const startIdx = list.findIndex(r => r.resno === dragStartResno);
  const endIdx   = list.findIndex(r => r.resno === currentResno);
  if (startIdx === -1 || endIdx === -1) return;

  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);

  // Restore this chain to pre-drag state
  for (const res of list) {
    const key = `${res.chain}:${res.resno}`;
    const wasMut = preDragMut.has(key);
    const wasFix = preDragFix.has(key);
    if (wasMut) mutationResidues.set(key, res); else mutationResidues.delete(key);
    if (wasFix) fixedResidues.set(key, res);    else fixedResidues.delete(key);
    refreshBox(res.chain, res.resno);
  }

  // Apply action to range
  for (let i = lo; i <= hi; i++) {
    const res = list[i];
    const key = `${res.chain}:${res.resno}`;
    if (dragAction === 'add') {
      if (selectionMode === 'mutation') { mutationResidues.set(key, res); fixedResidues.delete(key); }
      else                              { fixedResidues.set(key, res);    mutationResidues.delete(key); }
    } else {
      if (selectionMode === 'mutation') mutationResidues.delete(key);
      else                              fixedResidues.delete(key);
    }
    refreshBox(res.chain, res.resno);
  }

  deferNGL();
}

// ── Drag end (document-level mouseup) ───────────────────────────────────────
document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging     = false;
  dragAction     = null;
  dragChain      = null;
  dragStartResno = null;
  preDragMut     = null;
  preDragFix     = null;
  syncInputsFromMaps();
  clearTimeout(nglTimer);
  updateNGL();
});

// ── Residue selection toggle (single click / NGL pick) ───────────────────────
function toggleResidue(chain, resno) {
  const key = `${chain}:${resno}`;
  const info = findResidueInfo(chain, resno);

  if (selectionMode === 'mutation') {
    if (mutationResidues.has(key)) {
      mutationResidues.delete(key);
    } else {
      mutationResidues.set(key, info);
      fixedResidues.delete(key);
    }
  } else {
    if (fixedResidues.has(key)) {
      fixedResidues.delete(key);
    } else {
      fixedResidues.set(key, info);
      mutationResidues.delete(key);
    }
  }

  syncInputsFromMaps();
  renderSequence();
  updateNGL();
}

function findResidueInfo(chain, resno) {
  const list = chains.get(chain) ?? [];
  return list.find(r => r.resno === resno) ?? { chain, resno, name3: 'UNK' };
}

// ── Comma-list input sync ───────────────────────────────────────────────────
const defaultChain = () => chains.size > 0 ? chains.keys().next().value : 'A';
const multiChain   = () => chains.size > 1;

function syncInputsFromMaps() {
  suppressInputSync = true;

  const toNum = ({ chain, resno }) =>
    useSeqIndex ? (seqIndexMap.get(`${chain}:${resno}`) ?? resno) : resno;

  const fmt = (res) => {
    const num = toNum(res);
    return (showChainPrefix && multiChain()) ? `${res.chain}:${num}` : `${num}`;
  };

  const sortFn = (a, b) => toNum(a) - toNum(b);

  document.getElementById('mutation-input').value =
    [...mutationResidues.values()].sort(sortFn).map(fmt).join(',');

  document.getElementById('fixed-input').value =
    [...fixedResidues.values()].sort(sortFn).map(fmt).join(',');

  suppressInputSync = false;
}

function parseToken(token) {
  token = token.trim();
  if (!token) return null;

  let chain = defaultChain();
  let numStr = token;
  if (token.includes(':')) {
    const [c, n] = token.split(':');
    chain  = c.trim().toUpperCase();
    numStr = n.trim();
  }
  const num = parseInt(numStr);
  if (isNaN(num)) return null;

  if (useSeqIndex) {
    const res = seqIndexToRes.get(`${chain}:${num}`);
    return res ? { chain: res.chain, resno: res.resno } : null;
  }
  return { chain, resno: num };
}

function applyInput(inputId, targetMap, otherMap) {
  const val = document.getElementById(inputId).value;
  targetMap.clear();
  for (const tok of val.split(',')) {
    const p = parseToken(tok);
    if (!p) continue;
    const key  = `${p.chain}:${p.resno}`;
    const info = findResidueInfo(p.chain, p.resno);
    targetMap.set(key, info);
    otherMap.delete(key);   // a residue can't be in both groups
  }
}

// ── NGL debounce ────────────────────────────────────────────────────────────
let nglTimer = null;
function deferNGL() {
  clearTimeout(nglTimer);
  nglTimer = setTimeout(updateNGL, 250);
}

// ── File loading ────────────────────────────────────────────────────────────
async function loadFile(filePath, content) {
  document.getElementById('filename').textContent = filePath.split('/').pop();
  document.getElementById('empty-msg').style.display = 'none';

  chains = parsePDB(content);
  chainColorIndex.clear();
  seqIndexMap.clear();
  seqIndexToRes.clear();
  let idx = 0;
  for (const [chainId, residues] of chains) {
    chainColorIndex.set(chainId, idx++);
    residues.forEach((res, i) => {
      const si = i + 1;
      seqIndexMap.set(`${res.chain}:${res.resno}`, si);
      seqIndexToRes.set(`${res.chain}:${si}`, res);
    });
  }

  mutationResidues.clear();
  fixedResidues.clear();
  renderSequence();
  syncInputsFromMaps();

  if (component) {
    stage.removeComponent(component);
    component = null;
  }

  // Load PDB content via Blob URL so NGL treats it as a file
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  try {
    component = await stage.loadFile(url, { ext: 'pdb', defaultRepresentation: false });
    updateNGL();
    stage.autoView();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── UI wiring ───────────────────────────────────────────────────────────────
function setupUI() {
  document.getElementById('open-btn').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('open-pdb');
    if (!res || res.error) return;
    await loadFile(res.filePath, res.content);
  });

  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectionMode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Mutation comma list
  document.getElementById('mutation-input').addEventListener('input', () => {
    if (suppressInputSync) return;
    applyInput('mutation-input', mutationResidues, fixedResidues);
    syncInputsFromMaps();   // re-sync to clean formatting
    renderSequence();
    deferNGL();
  });

  // Fixed comma list
  document.getElementById('fixed-input').addEventListener('input', () => {
    if (suppressInputSync) return;
    applyInput('fixed-input', fixedResidues, mutationResidues);
    syncInputsFromMaps();
    renderSequence();
    deferNGL();
  });

  document.getElementById('clear-mutation').addEventListener('click', () => {
    mutationResidues.clear();
    syncInputsFromMaps();
    renderSequence();
    updateNGL();
  });

  document.getElementById('clear-fixed').addEventListener('click', () => {
    fixedResidues.clear();
    syncInputsFromMaps();
    renderSequence();
    updateNGL();
  });

  document.getElementById('seq-index-toggle').addEventListener('change', (e) => {
    useSeqIndex = e.target.checked;
    syncInputsFromMaps();
    renderSequence();
  });

  document.getElementById('chain-prefix-toggle').addEventListener('change', (e) => {
    showChainPrefix = e.target.checked;
    syncInputsFromMaps();
  });

  // Set all non-mutation residues as fixed
  document.getElementById('mut-complement').addEventListener('click', () => {
    fixedResidues.clear();
    for (const [, residues] of chains) {
      for (const res of residues) {
        const key = `${res.chain}:${res.resno}`;
        if (!mutationResidues.has(key)) fixedResidues.set(key, res);
      }
    }
    syncInputsFromMaps(); renderSequence(); updateNGL();
  });

  // Set all non-fixed residues as mutation
  document.getElementById('fix-complement').addEventListener('click', () => {
    mutationResidues.clear();
    for (const [, residues] of chains) {
      for (const res of residues) {
        const key = `${res.chain}:${res.resno}`;
        if (!fixedResidues.has(key)) mutationResidues.set(key, res);
      }
    }
    syncInputsFromMaps(); renderSequence(); updateNGL();
  });

  document.getElementById('swap-groups').addEventListener('click', () => {
    const tmp = new Map(mutationResidues);
    mutationResidues.clear();
    for (const [k, v] of fixedResidues) mutationResidues.set(k, v);
    fixedResidues.clear();
    for (const [k, v] of tmp) fixedResidues.set(k, v);
    syncInputsFromMaps(); renderSequence(); updateNGL();
  });

  document.getElementById('clear-all').addEventListener('click', () => {
    mutationResidues.clear();
    fixedResidues.clear();
    syncInputsFromMaps();
    renderSequence();
    updateNGL();
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initStage();
  setupUI();
});

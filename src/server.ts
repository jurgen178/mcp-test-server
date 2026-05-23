import { randomUUID } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import * as ts from 'typescript';
import { McpServer, RegisteredPrompt, RegisteredResource, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, GetPromptResult, ReadResourceResult, isInitializeRequest, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const MCP_PORT = Number(process.env.PORT) || 3000;
const LIVE_RESOURCE_URI = 'resource://mcp-test-server/live-status';
const DYNAMIC_RESOURCE_URI = 'resource://mcp-test-server/dynamic-note';

type SessionContext = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  dynamicResource: RegisteredResource;
  dynamicPrompt: RegisteredPrompt;
  dynamicTool: RegisteredTool;
  eventTimer?: NodeJS.Timeout;
};

const sessions = new Map<string, SessionContext>();
// uri → Set of sessionIds that have subscribed to that resource
const subscriptions = new Map<string, Set<string>>();

const liveState = {
  version: 0,
  message: 'Server started',
  source: 'bootstrap',
  updatedAt: new Date().toISOString(),
};

// ── Server Stats Tracker ────────────────────────────────────────────────────
interface CallRecord { tool: string; ms: number; ts: number; }
const serverStats = {
  startTime: Date.now(),
  callCounts: new Map<string, number>(),
  recent: [] as CallRecord[],
};

const getHeaderValue = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const updateLiveState = (message: string, source: string) => {
  liveState.version += 1;
  liveState.message = message;
  liveState.source = source;
  liveState.updatedAt = new Date().toISOString();
};

const removeSessionSubscriptions = (sessionId: string) => {
  for (const subs of subscriptions.values()) {
    subs.delete(sessionId);
  }
};

const stopEventTimer = (context: SessionContext) => {
  if (context.eventTimer) {
    clearInterval(context.eventTimer);
    context.eventTimer = undefined;
  }
};

const setEnabledState = (
  registeredItem: RegisteredResource | RegisteredPrompt | RegisteredTool,
  enabled: boolean
) => {
  if (enabled) {
    registeredItem.enable();
    return 'enabled';
  }

  registeredItem.disable();
  return 'disabled';
};

const emitLiveUpdate = async (message: string, source: string, sessionIds?: string[]) => {
  updateLiveState(message, source);

  const targetSessionIds = sessionIds ?? Array.from(sessions.keys());

  await Promise.all(targetSessionIds.map(async (sessionId) => {
    const context = sessions.get(sessionId);

    if (!context || !context.server.isConnected()) {
      return;
    }

    try {
      await context.server.sendLoggingMessage(
        {
          level: 'info',
          logger: 'mcp-test-server',
          data: {
            event: 'live-update',
            message,
            source,
            version: liveState.version,
            updatedAt: liveState.updatedAt,
          },
        },
        sessionId
      );

      if (subscriptions.get(LIVE_RESOURCE_URI)?.has(sessionId)) {
        await context.server.server.sendResourceUpdated({
          uri: LIVE_RESOURCE_URI,
        });
      }
    } catch (error) {
      console.error(`Failed to send live update for session ${sessionId}:`, error);
    }
  }));
};

const startEventBurst = (sessionId: string, ticks: number, delayMs: number) => {
  const context = sessions.get(sessionId);

  if (!context) {
    return false;
  }

  stopEventTimer(context);

  let currentTick = 0;

  context.eventTimer = setInterval(() => {
    const activeContext = sessions.get(sessionId);

    if (!activeContext) {
      return;
    }

    currentTick += 1;
    void emitLiveUpdate(
      `Event burst tick ${currentTick}/${ticks}`,
      'event-burst',
      [sessionId]
    );

    if (currentTick >= ticks) {
      stopEventTimer(activeContext);
    }
  }, delayMs);

  return true;
};

// Regex tokenizer

type RegexToken = { type: string; value: string; description: string };

function tokenizeRegex(pattern: string): RegexToken[] {
  const tokens: RegexToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '^') {
      tokens.push({ type: 'anchor', value: '^', description: 'Start of string' });
      i++;
    } else if (ch === '$') {
      tokens.push({ type: 'anchor', value: '$', description: 'End of string' });
      i++;
    } else if (ch === '.') {
      tokens.push({ type: 'wildcard', value: '.', description: 'Any character (except newline)' });
      i++;
    } else if (ch === '|') {
      tokens.push({ type: 'alternation', value: '|', description: 'OR — match either side' });
      i++;
    } else if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      const map: Record<string, string> = {
        d: 'Digit [0-9]', D: 'Non-digit', w: 'Word char [a-zA-Z0-9_]', W: 'Non-word char',
        s: 'Whitespace', S: 'Non-whitespace', b: 'Word boundary', B: 'Non-word boundary',
        n: 'Newline', t: 'Tab', r: 'Carriage return',
      };
      tokens.push({ type: 'escape', value: `\\${next}`, description: map[next] ?? `Escaped '${next}'` });
      i += 2;
    } else if (ch === '[') {
      let j = i + 1;
      const negated = pattern[j] === '^';
      if (negated) j++;
      while (j < pattern.length && !(pattern[j] === ']' && pattern[j - 1] !== '\\')) j++;
      const val = pattern.slice(i, j + 1);
      const inner = negated ? val.slice(2, -1) : val.slice(1, -1);
      tokens.push({ type: 'charClass', value: val.length > 12 ? val.slice(0, 10) + '…]' : val, description: negated ? `NOT in [${inner}]` : `One of [${inner}]` });
      i = j + 1;
    } else if (ch === '(') {
      let j = i + 1;
      let depth = 1;
      while (j < pattern.length && depth > 0) {
        if (pattern[j] === '(' && pattern[j - 1] !== '\\') depth++;
        if (pattern[j] === ')' && pattern[j - 1] !== '\\') depth--;
        j++;
      }
      const val = pattern.slice(i, j);
      let kind = 'Capture group';
      if (val.startsWith('(?:')) kind = 'Non-capturing group';
      else if (val.startsWith('(?=')) kind = 'Lookahead (positive)';
      else if (val.startsWith('(?!')) kind = 'Lookahead (negative)';
      else if (val.startsWith('(?<=')) kind = 'Lookbehind (positive)';
      else if (val.startsWith('(?<!')) kind = 'Lookbehind (negative)';
      else if (val.startsWith('(?<')) kind = 'Named capture group';
      tokens.push({ type: 'group', value: val.length > 16 ? val.slice(0, 14) + '…)' : val, description: kind });
      i = j;
    } else if (ch === '*' || ch === '+' || ch === '?') {
      const lazy = pattern[i + 1] === '?';
      const baseDesc = ch === '*' ? '0 or more' : ch === '+' ? '1 or more' : 'Optional (0 or 1)';
      tokens.push({ type: 'quantifier', value: lazy ? ch + '?' : ch, description: `${baseDesc}${lazy ? ' — lazy' : ' — greedy'}` });
      i += lazy ? 2 : 1;
    } else if (ch === '{') {
      const j = pattern.indexOf('}', i);
      if (j !== -1) {
        const val = pattern.slice(i, j + 1);
        const inside = val.slice(1, -1);
        const parts = inside.split(',');
        const lazy = pattern[j + 1] === '?';
        const desc = parts.length === 1 ? `Exactly ${parts[0]} times` : parts[1] === '' ? `${parts[0]} or more times` : `${parts[0]} to ${parts[1]} times`;
        tokens.push({ type: 'quantifier', value: lazy ? val + '?' : val, description: desc + (lazy ? ' — lazy' : ' — greedy') });
        i = j + 1 + (lazy ? 1 : 0);
      } else {
        tokens.push({ type: 'literal', value: '{', description: 'Literal "{"' });
        i++;
      }
    } else {
      let j = i + 1;
      while (j < pattern.length && !'\\[](){}*+?|^$.'.includes(pattern[j])) j++;
      const lit = pattern.slice(i, j);
      tokens.push({ type: 'literal', value: lit.length > 12 ? lit.slice(0, 10) + '…' : lit, description: `Literal "${lit}"` });
      i = j;
    }
  }
  return tokens;
}

// MCP App HTML: Regex Visualizer

function getRegexVisualizerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--mcp-bg,#0d1117);color:var(--mcp-fg,#e6edf3);padding:16px;font-size:14px}
.controls{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end}
.ctrl-group{display:flex;flex-direction:column;gap:4px;flex:1;min-width:120px}
.ctrl-group.flags-group{flex:0 0 90px}
.ctrl-group.ts-group{flex:2}
.ctrl-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--mcp-muted,#8b949e)}
.ctrl-input{background:var(--mcp-input-bg,#161b22);border:1px solid var(--mcp-input-border,#30363d);border-radius:7px;padding:8px 11px;font-family:monospace;font-size:14px;color:var(--mcp-accent,#79c0ff);outline:none;width:100%;transition:border-color .15s}
.ctrl-input:focus{border-color:var(--mcp-accent,#388bfd)}
.ctrl-input.ts-input{color:var(--mcp-input-fg,#e6edf3)}
.ctrl-input.err-border{border-color:var(--mcp-red,#f85149)}
.divider{border:none;border-top:1px solid var(--mcp-border2,#21262d);margin:4px 0 12px}
.section-label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--mcp-muted,#8b949e);margin:12px 0 7px}
.token-rail{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0}
.token{display:inline-flex;flex-direction:column;align-items:center;border-radius:7px;padding:6px 10px;cursor:default;position:relative;min-width:38px;transition:transform .12s,box-shadow .12s}
.token:hover{transform:translateY(-3px);box-shadow:0 4px 16px rgba(128,128,128,.3)}
.token:hover .tip{opacity:1;pointer-events:auto}
.tok-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.6px;opacity:.75;margin-bottom:3px}
.tok-val{font-family:monospace;font-size:13px;font-weight:700}
.tip{position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);background:var(--mcp-bg2,#1c2128);border:1px solid var(--mcp-border,#30363d);border-radius:7px;padding:5px 10px;font-size:12px;white-space:nowrap;opacity:0;transition:opacity .15s;pointer-events:none;z-index:20;color:var(--mcp-fg,#e6edf3)}
.tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--mcp-bg2,#1c2128)}
.t-literal{background:#0d2149;color:#79c0ff}.t-anchor{background:#2d1557;color:#d2a8ff}
.t-wildcard{background:#4a1a04;color:#ffa657}.t-charClass{background:#0a2e1a;color:#7ee787}
.t-group{background:#05282a;color:#39d0d8}.t-quantifier{background:#3a2800;color:#e3b341}
.t-escape{background:#3a0a20;color:#f778ba}.t-alternation{background:var(--mcp-bg2,#1c2128);color:var(--mcp-muted,#8b949e)}
.test-box{background:var(--mcp-input-bg,#161b22);border:1px solid var(--mcp-border,#30363d);border-radius:8px;padding:11px 15px;font-family:monospace;font-size:15px;line-height:1.7;word-break:break-all}
mark.hl{background:rgba(86,211,100,.25);border-bottom:2px solid #56d364;border-radius:2px;color:inherit}
.no-match{margin-top:9px;color:var(--mcp-red,#f85149);font-size:13px}
.match-meta{margin-top:8px;font-size:13px;color:var(--mcp-muted,#8b949e)}
.grp{display:inline-block;background:var(--mcp-bg2,#1c2128);border:1px solid var(--mcp-border,#30363d);border-radius:4px;padding:2px 7px;margin:2px 3px;font-family:monospace;font-size:12px}
.err{background:rgba(248,81,73,.08);border:1px solid var(--mcp-red,#f85149);border-radius:8px;padding:12px 15px;color:var(--mcp-red,#f85149);margin-top:12px;font-size:13px}
.loading{color:var(--mcp-muted,#8b949e);font-style:italic}
.spinner{display:inline-block;width:10px;height:10px;border:2px solid var(--mcp-border,#30363d);border-top-color:var(--mcp-accent,#388bfd);border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="controls">
  <div class="ctrl-group">
    <span class="ctrl-label">Pattern</span>
    <input id="inp-pat" class="ctrl-input" placeholder="e.g. (\\w+)@(\\w+)" spellcheck="false" autocomplete="off">
  </div>
  <div class="ctrl-group flags-group">
    <span class="ctrl-label">Flags</span>
    <input id="inp-flags" class="ctrl-input" placeholder="gi" spellcheck="false" autocomplete="off" maxlength="8">
  </div>
  <div class="ctrl-group ts-group">
    <span class="ctrl-label">Test string</span>
    <input id="inp-ts" class="ctrl-input ts-input" placeholder="hello@world.com" spellcheck="false">
  </div>
</div>
<hr class="divider">
<div id="result"></div>
<script>
(function(){
  var rid=0,pend={};
  function request(m,p){var id=++rid;return new Promise(function(ok){pend[id]=ok;window.parent.postMessage({jsonrpc:'2.0',id:id,method:m,params:p},'*');});}
  function notify(m,p){window.parent.postMessage({jsonrpc:'2.0',method:m,params:p},'*');}
  window.addEventListener('message',function(ev){
    var msg=ev.data;if(!msg||msg.jsonrpc!=='2.0')return;
    if(msg.id!==undefined&&pend[msg.id]){pend[msg.id](msg.result);delete pend[msg.id];return;}
    if(msg.method==='ui/notifications/tool-input'){
      var a=msg.params&&msg.params.arguments||{};
      if(a.pattern!=null)document.getElementById('inp-pat').value=a.pattern;
      if(a.flags!=null)document.getElementById('inp-flags').value=a.flags||'';
      if(a.testString!=null)document.getElementById('inp-ts').value=a.testString;
    }
    else if(msg.method==='ui/notifications/tool-result'){renderSc((msg.params||{}).structuredContent);}
  });
  var COLORS={literal:'t-literal',anchor:'t-anchor',wildcard:'t-wildcard',charClass:'t-charClass',group:'t-group',quantifier:'t-quantifier',escape:'t-escape',alternation:'t-alternation'};
  var LABELS={literal:'text',anchor:'anchor',wildcard:'any',charClass:'class',group:'group',quantifier:'x',escape:'esc',alternation:'or'};
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function renderSc(sc){
    var el=document.getElementById('result');
    if(!sc){el.innerHTML='<p class="loading">Waiting for data\u2026</p>';return;}
    var pat=document.getElementById('inp-pat');
    pat.classList.toggle('err-border',!sc.isValid);
    var h='';
    if(!sc.isValid){
      h='<div class="err">\u26a0 Invalid regex: '+esc(sc.error)+'</div>';
      el.innerHTML=h;notifySize();return;
    }
    if(sc.tokens&&sc.tokens.length){
      h+='<div class="section-label">Structure \u00b7 '+sc.tokens.length+' tokens</div><div class="token-rail">';
      sc.tokens.forEach(function(t){
        var cls=COLORS[t.type]||'t-literal',lbl=LABELS[t.type]||t.type;
        h+='<div class="token '+cls+'"><span class="tok-lbl">'+esc(lbl)+'</span><span class="tok-val">'+esc(t.value)+'</span><div class="tip">'+esc(t.description)+'</div></div>';
      });
      h+='</div>';
    }
    if(sc.testString!=null){
      h+='<div class="section-label">Test string</div>';
      if(sc.matchResult&&sc.matchResult.matched){
        var s=sc.testString,idx=sc.matchResult.index||0,fm=sc.matchResult.fullMatch||'';
        h+='<div class="test-box">'+esc(s.slice(0,idx))+'<mark class="hl">'+esc(fm)+'</mark>'+esc(s.slice(idx+fm.length))+'</div>';
        h+='<div class="match-meta">\u2713 Match at index '+idx;
        if(sc.matchResult.groups&&sc.matchResult.groups.length){
          h+=' &nbsp;Groups: ';
          sc.matchResult.groups.forEach(function(g){h+='<span class="grp">$'+g.index+': '+esc(g.value!=null?g.value:'\u2013')+'</span>';});
        }
        if(sc.matchResult.namedGroups){
          var ng=sc.matchResult.namedGroups,keys=Object.keys(ng);
          if(keys.length){h+=' &nbsp;Named: ';keys.forEach(function(k){h+='<span class="grp">'+esc(k)+': '+esc(ng[k])+'</span>';});}
        }
        h+='</div>';
      } else {
        h+='<div class="test-box">'+esc(sc.testString)+'</div>';
        h+='<div class="no-match">\u2717 No match</div>';
      }
    }
    el.innerHTML=h;
    notifySize();
  }
  function notifySize(){setTimeout(function(){notify('ui/notifications/size-changed',{height:document.body.scrollHeight+12});},60);}

  var debounce=null;
  function scheduleCall(){
    clearTimeout(debounce);
    debounce=setTimeout(doCall,380);
  }
  function doCall(){
    var pat=document.getElementById('inp-pat').value;
    if(!pat)return;
    var flags=document.getElementById('inp-flags').value||undefined;
    var ts=document.getElementById('inp-ts').value||undefined;
    request('tools/call',{name:'visualizeRegex',arguments:{pattern:pat,flags:flags,testString:ts}})
      .then(function(r){renderSc(r&&r.structuredContent);})
      .catch(function(e){document.getElementById('result').innerHTML='<div class="err">Error: '+esc(String(e))+'</div>';});
  }
  ['inp-pat','inp-flags','inp-ts'].forEach(function(id){
    document.getElementById(id).addEventListener('input',scheduleCall);
  });

  async function init(){
    try{
      await request('initialize',{protocolVersion:'2026-01-26',capabilities:{},clientInfo:{name:'regex-viz',version:'1.0'}});
      notify('notifications/initialized');
      await request('ui/initialize',{protocolVersion:'2026-01-26',clientCapabilities:{},clientInfo:{name:'regex-viz',version:'1.0'}});
      notify('ui/notifications/initialized');
    }catch(e){document.getElementById('result').innerHTML='<div class="err">Init error: '+esc(String(e))+'</div>';}
  }
  window.addEventListener('DOMContentLoaded',init);
})();
</script>
</body>
</html>`;
}

// MCP App HTML: Fractal Explorer

function getFractalExplorerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;overflow:hidden}
#wrap{position:relative;width:100%}
#canvas{display:block;width:100%;cursor:crosshair}
#prog{position:absolute;top:0;left:0;right:0;height:3px;background:rgba(255,255,255,.08)}
#progbar{height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#06b6d4);transition:width .08s}
#info{position:absolute;bottom:12px;left:12px;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 13px;font:12px/1.5 monospace;color:rgba(255,255,255,.82);backdrop-filter:blur(6px);pointer-events:none}
#info b{color:#79c0ff}
#hint{position:absolute;bottom:12px;right:12px;background:rgba(0,0,0,.6);border-radius:6px;padding:5px 9px;font:11px monospace;color:rgba(255,255,255,.45);pointer-events:none}
#controls{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;background:rgba(0,0,0,.75);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:7px 12px;backdrop-filter:blur(8px)}
.ctrl-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:6px;color:rgba(255,255,255,.85);font:12px monospace;padding:4px 10px;cursor:pointer;transition:background .15s}
.ctrl-btn:hover,.ctrl-btn.active{background:rgba(56,139,253,.35);border-color:#388bfd}
.ctrl-sep{width:1px;height:20px;background:rgba(255,255,255,.12);flex-shrink:0}
.ctrl-label{font:10px monospace;color:rgba(255,255,255,.4);user-select:none}
.ctrl-slider{accent-color:#388bfd;cursor:pointer;width:80px}
</style>
</head>
<body>
<div id="wrap">
  <div id="prog"><div id="progbar"></div></div>
  <canvas id="canvas"></canvas>
  <div id="controls">
    <span class="ctrl-label">Type</span>
    <button class="ctrl-btn active" id="btn-mandel" onclick="setType('mandelbrot')">Mandelbrot</button>
    <button class="ctrl-btn" id="btn-julia" onclick="setType('julia')">Julia</button>
    <div class="ctrl-sep"></div>
    <span class="ctrl-label">Palette</span>
    <button class="ctrl-btn" id="btn-pal-electric" onclick="setPalette('electric')">Electric</button>
    <button class="ctrl-btn" id="btn-pal-fire" onclick="setPalette('fire')">Fire</button>
    <button class="ctrl-btn" id="btn-pal-ocean" onclick="setPalette('ocean')">Ocean</button>
    <button class="ctrl-btn" id="btn-pal-aurora" onclick="setPalette('aurora')">Aurora</button>
    <button class="ctrl-btn" id="btn-pal-gold" onclick="setPalette('gold')">Gold</button>
    <div class="ctrl-sep"></div>
    <span class="ctrl-label">Iter</span>
    <input type="range" class="ctrl-slider" id="sl-iter" min="50" max="1000" step="50" value="300" oninput="setIter(+this.value)">
    <span id="lbl-iter" style="font:11px monospace;color:rgba(255,255,255,.7);min-width:28px">300</span>
    <div class="ctrl-sep"></div>
    <button class="ctrl-btn" onclick="resetView()">Reset</button>
  </div>
  <div id="info">Connecting\u2026</div>
  <div id="hint">Click to zoom 3\u00d7</div>
</div>
<script>
(function(){
  var rid=0,pend={};
  function request(m,p){var id=++rid;return new Promise(function(ok){pend[id]=ok;window.parent.postMessage({jsonrpc:'2.0',id:id,method:m,params:p},'*');});}
  function notify(m,p){window.parent.postMessage({jsonrpc:'2.0',method:m,params:p},'*');}
  window.addEventListener('message',function(ev){
    var msg=ev.data;if(!msg||msg.jsonrpc!=='2.0')return;
    if(msg.id!==undefined&&pend[msg.id]){pend[msg.id](msg.result);delete pend[msg.id];return;}
    if(msg.method==='ui/notifications/tool-result'){
      var sc=(msg.params||{}).structuredContent;
      if(sc){initParams(sc);startRender(liveParams);}
    }
  });

  // Color palettes
  var PAL={
    electric:function(t){var s=t<.5?t*2:(t-.5)*2;return t<.5?[~~(s*30),~~(s*120),~~(50+s*180)]:[~~(30+s*225),~~(120+s*135),~~(230-s*150)];},
    fire:function(t){if(t<.33){var s=t/.33;return[~~(s*180),0,0];}if(t<.66){var s=(t-.33)/.33;return[~~(180+s*75),~~(s*180),0];}var s=(t-.66)/.34;return[255,~~(180+s*75),~~(s*255)];},
    ocean:function(t){if(t<.5){var s=t*2;return[0,~~(s*80),~~(40+s*140)];}var s=(t-.5)*2;return[~~(s*100),~~(80+s*120),~~(180+s*55)];},
    aurora:function(t){if(t<.4){var s=t/.4;return[~~(40+s*100),~~(s*20),~~(80+s*100)];}if(t<.7){var s=(t-.4)/.3;return[~~(140-s*80),~~(20+s*180),~~(180-s*80)];}var s=(t-.7)/.3;return[~~(60+s*195),~~(200-s*100),~~(100+s*155)];},
    gold:function(t){if(t<.5){var s=t*2;return[~~(s*200),~~(s*160),0];}var s=(t-.5)*2;return[~~(200+s*55),~~(160+s*95),~~(s*200)];}
  };

  var renderToken=0,liveParams=null,baseParams=null;
  var PALETTES=['electric','fire','ocean','aurora','gold'];

  function initParams(sc){
    baseParams=JSON.parse(JSON.stringify(sc));
    liveParams=JSON.parse(JSON.stringify(sc));
    document.getElementById('sl-iter').value=String(sc.maxIterations||300);
    document.getElementById('lbl-iter').textContent=String(sc.maxIterations||300);
    var isMandel=(sc.type||'mandelbrot')==='mandelbrot';
    document.getElementById('btn-mandel').classList.toggle('active',isMandel);
    document.getElementById('btn-julia').classList.toggle('active',!isMandel);
    PALETTES.forEach(function(p){document.getElementById('btn-pal-'+p).classList.toggle('active',p===(sc.palette||'electric'));});
  }

  window.setType=function(t){
    if(!liveParams)return;
    liveParams.type=t;
    document.getElementById('btn-mandel').classList.toggle('active',t==='mandelbrot');
    document.getElementById('btn-julia').classList.toggle('active',t==='julia');
    startRender(liveParams);
  };
  window.setPalette=function(p){
    PALETTES.forEach(function(q){document.getElementById('btn-pal-'+q).classList.remove('active');});
    document.getElementById('btn-pal-'+p).classList.add('active');
    if(!liveParams)return;liveParams.palette=p;startRender(liveParams);
  };
  window.setIter=function(n){
    document.getElementById('lbl-iter').textContent=String(n);
    if(!liveParams)return;
    liveParams.maxIterations=n;
    startRender(liveParams);
  };
  window.resetView=function(){
    if(!baseParams)return;
    liveParams=JSON.parse(JSON.stringify(baseParams));
    document.getElementById('sl-iter').value=String(liveParams.maxIterations||300);
    document.getElementById('lbl-iter').textContent=String(liveParams.maxIterations||300);
    PALETTES.forEach(function(p){document.getElementById('btn-pal-'+p).classList.toggle('active',p===(liveParams.palette||'electric'));});
    startRender(liveParams);
  };

  function startRender(sc){
    liveParams=JSON.parse(JSON.stringify(sc));
    var tok=++renderToken;
    var canvas=document.getElementById('canvas');
    var W=Math.min(window.innerWidth,1400);
    var H=Math.round(W*.6);
    canvas.width=W;canvas.height=H;
    var info=document.getElementById('info');
    var typeLabel=sc.type==='julia'
      ?'Julia set &nbsp;<b>c='+(sc.juliaC?(sc.juliaC.re.toFixed(4)+'+'+sc.juliaC.im.toFixed(4)+'i'):'?')+'</b>'
      :'<b>Mandelbrot</b> set';
    info.innerHTML=typeLabel+'<br>Palette: <b>'+sc.palette+'</b> \u00b7 Zoom: <b>'+formatZoom(sc.zoom)+'</b><br><span style="color:#8b949e">Rendering\u2026</span>';
    document.getElementById('progbar').style.width='0%';
    var ctx=canvas.getContext('2d');
    var imgData=ctx.createImageData(W,H);
    var d=imgData.data;
    var pal=PAL[sc.palette]||PAL.electric;
    var maxIter=sc.maxIterations||300;
    var zoom=sc.zoom||1;
    var cx=sc.center?sc.center.x:-.5,cy=sc.center?sc.center.y:0;
    var vpW=3.5/zoom,vpH=vpW*(H/W);
    var x0=cx-vpW/2,y0=cy-vpH/2;
    var CHUNK=12,row=0;
    function renderChunk(){
      if(renderToken!==tok)return;
      for(var r=0;r<CHUNK&&row<H;r++,row++){
        for(var col=0;col<W;col++){
          var re=x0+col*vpW/W,im=y0+row*vpH/H;
          var zr,zi,zr2,zi2,iter;
          if(sc.type==='julia'){
            zr=re;zi=im;
            var cr=sc.juliaC?sc.juliaC.re:-.7269,ci=sc.juliaC?sc.juliaC.im:.1889;
            for(iter=0;iter<maxIter;iter++){zr2=zr*zr;zi2=zi*zi;if(zr2+zi2>4)break;zi=2*zr*zi+ci;zr=zr2-zi2+cr;}
          } else {
            zr=0;zi=0;
            for(iter=0;iter<maxIter;iter++){zr2=zr*zr;zi2=zi*zi;if(zr2+zi2>4)break;zi=2*zr*zi+im;zr=zr2-zi2+re;}
          }
          var px=(row*W+col)*4;
          if(iter===maxIter){d[px]=d[px+1]=d[px+2]=0;}
          else{
            var logZn=Math.log(zr*zr+zi*zi)*.5;
            var nu=Math.log(logZn/Math.log(2))/Math.log(2);
            var t=((iter+1-nu)/30)%1;
            var rgb=pal(Math.max(0,Math.min(1,t<0?t+1:t)));
            d[px]=rgb[0];d[px+1]=rgb[1];d[px+2]=rgb[2];
          }
          d[px+3]=255;
        }
      }
      ctx.putImageData(imgData,0,0);
      document.getElementById('progbar').style.width=(row/H*100)+'%';
      if(row<H){requestAnimationFrame(renderChunk);}
      else{
        document.getElementById('progbar').style.width='100%';
        info.innerHTML=typeLabel+'<br>Palette: <b>'+sc.palette+'</b> \u00b7 Zoom: <b>'+formatZoom(sc.zoom)+'</b><br>'+W+'\u00d7'+H+' \u00b7 '+maxIter+' iters';
        setTimeout(function(){document.getElementById('progbar').style.width='0%';},600);
        notify('ui/notifications/size-changed',{height:H+4});
      }
    }
    requestAnimationFrame(renderChunk);
    canvas.onclick=function(e){
      if(!liveParams)return;
      var rect=canvas.getBoundingClientRect();
      var mx=(e.clientX-rect.left)/rect.width;
      var my=(e.clientY-rect.top)/rect.height;
      var p=liveParams;
      var vW=3.5/(p.zoom||1),vH=vW*(H/W);
      var x0c=(p.center?p.center.x:-.5)-vW/2,y0c=(p.center?p.center.y:0)-vH/2;
      liveParams=Object.assign({},p,{center:{x:x0c+mx*vW,y:y0c+my*vH},zoom:(p.zoom||1)*3});
      startRender(liveParams);
    };
  }
  function formatZoom(z){if(!z||z<1000)return(z||1).toFixed(z<10?2:0)+'\u00d7';return z.toExponential(1)+'\u00d7';}
  async function init(){
    try{
      await request('initialize',{protocolVersion:'2026-01-26',capabilities:{},clientInfo:{name:'fractal-explorer',version:'1.0'}});
      notify('notifications/initialized');
      await request('ui/initialize',{protocolVersion:'2026-01-26',clientCapabilities:{},clientInfo:{name:'fractal-explorer',version:'1.0'}});
      notify('ui/notifications/initialized');
    }catch(e){document.getElementById('info').textContent='Init error: '+e;}
  }
  window.addEventListener('DOMContentLoaded',init);
})();
</script>
</body>
</html>`;
}

// AST Explorer

interface AstNode {
  kind: string;
  name?: string;
  text?: string;
  children: AstNode[];
}

const DECL_KINDS = new Set(['FunctionDeclaration','FunctionExpression','ArrowFunction','ClassDeclaration','ClassExpression','MethodDeclaration','VariableDeclaration','VariableStatement','Parameter','PropertyDeclaration','EnumDeclaration','InterfaceDeclaration','TypeAliasDeclaration','ImportDeclaration','ExportDeclaration','Constructor']);
const EXPR_KINDS = new Set(['CallExpression','NewExpression','BinaryExpression','ConditionalExpression','PropertyAccessExpression','ElementAccessExpression','AwaitExpression','PrefixUnaryExpression','PostfixUnaryExpression','AsExpression','ObjectLiteralExpression','ArrayLiteralExpression','TemplateExpression','TaggedTemplateExpression','SpreadElement']);
const STMT_KINDS = new Set(['IfStatement','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoStatement','ReturnStatement','ThrowStatement','TryStatement','SwitchStatement','Block','ExpressionStatement','BreakStatement','ContinueStatement','LabeledStatement']);
const LIT_KINDS  = new Set(['StringLiteral','NumericLiteral','BigIntLiteral','RegularExpressionLiteral','TrueKeyword','FalseKeyword','NullKeyword','NoSubstitutionTemplateLiteral','UndefinedKeyword']);

function simplifyAst(node: ts.Node, sf: ts.SourceFile, depth: number, budget: { left: number }): AstNode {
  budget.left--;
  const kind = ts.SyntaxKind[node.kind];
  let name: string | undefined;
  let text: string | undefined;
  if (ts.isIdentifier(node)) { text = node.text.slice(0, 30); }
  else if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) { text = node.getText(sf).slice(0, 30); }
  if ((node as ts.NamedDeclaration).name && ts.isIdentifier((node as ts.NamedDeclaration).name!)) {
    name = ((node as ts.NamedDeclaration).name as ts.Identifier).text;
  }
  const children: AstNode[] = [];
  if (depth < 8 && budget.left > 0) {
    node.forEachChild(child => {
      if (budget.left > 0) children.push(simplifyAst(child, sf, depth + 1, budget));
    });
  }
  return { kind, name, text, children };
}

// Code Diff

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
  lineA: number | null;
  lineB: number | null;
}

function computeDiff(a: string[], b: string[]): DiffLine[] {
  const m = a.length, n = b.length;
  // O(m*n) LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  // Backtrack
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'unchanged', text: a[i - 1], lineA: i, lineB: j }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', text: b[j - 1], lineA: null, lineB: j }); j--;
    } else {
      result.push({ type: 'removed', text: a[i - 1], lineA: i, lineB: null }); i--;
    }
  }
  return result.reverse();
}

// MCP App HTML: AST Explorer

function getAstExplorerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--mcp-bg,#0d1117);color:var(--mcp-fg,#e6edf3);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;padding:16px}
.topbar{display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.stat{background:var(--mcp-bg2,#161b22);border:1px solid var(--mcp-border,#30363d);border-radius:6px;padding:4px 10px;font-size:12px;color:var(--mcp-muted,#8b949e)}
.stat b{color:var(--mcp-accent,#79c0ff)}
#tree{font-family:monospace;font-size:12px;line-height:1.7}
.nr{display:flex;align-items:baseline;gap:4px;padding:1px 0;white-space:nowrap;cursor:default}
.nr:hover{background:rgba(128,128,128,.07);border-radius:4px}
.tog{width:14px;text-align:center;cursor:pointer;color:var(--mcp-muted,#8b949e);flex-shrink:0;user-select:none}
.tog:hover{color:var(--mcp-fg,#e6edf3)}
.sp{width:14px;flex-shrink:0}
.decl{color:#79c0ff}.expr{color:#7ee787}.stmt{color:#ffa657}.lit{color:#d2a8ff}.id{color:var(--mcp-muted,#8b949e)}.other{color:var(--mcp-fg,#e6edf3)}
.nm{color:#e3b341}.tx{color:#a5d6ff;opacity:.8}
.children{border-left:1px solid var(--mcp-border2,#21262d);margin-left:6px}
.loading{color:var(--mcp-muted,#8b949e);font-style:italic}
.err{color:var(--mcp-red,#f85149);padding:8px;background:rgba(248,81,73,.08);border-radius:6px}
</style>
</head>
<body>
<div id="topbar" class="topbar"></div>
<div id="tree"><p class="loading">Connecting…</p></div>
<script>
(function(){
  var rid=0,pend={};
  function request(m,p){var id=++rid;return new Promise(function(ok){pend[id]=ok;window.parent.postMessage({jsonrpc:'2.0',id:id,method:m,params:p},'*');});}
  function notify(m,p){window.parent.postMessage({jsonrpc:'2.0',method:m,params:p},'*');}
  var tArgs=null,tResult=null;
  window.addEventListener('message',function(ev){
    var msg=ev.data;if(!msg||msg.jsonrpc!=='2.0')return;
    if(msg.id!==undefined&&pend[msg.id]){pend[msg.id](msg.result);delete pend[msg.id];return;}
    if(msg.method==='ui/notifications/tool-input'){tArgs=msg.params&&msg.params.arguments||{};}
    else if(msg.method==='ui/notifications/tool-result'){tResult=msg.params||{};tryRender();}
  });
  function tryRender(){if(tResult)render(tArgs,tResult);}
  var DECL=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunction','ClassDeclaration','ClassExpression','MethodDeclaration','VariableDeclaration','VariableStatement','Parameter','PropertyDeclaration','EnumDeclaration','InterfaceDeclaration','TypeAliasDeclaration','ImportDeclaration','ExportDeclaration','Constructor']);
  var EXPR=new Set(['CallExpression','NewExpression','BinaryExpression','ConditionalExpression','PropertyAccessExpression','ElementAccessExpression','AwaitExpression','PrefixUnaryExpression','PostfixUnaryExpression','AsExpression','ObjectLiteralExpression','ArrayLiteralExpression','TemplateExpression','SpreadElement']);
  var STMT=new Set(['IfStatement','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoStatement','ReturnStatement','ThrowStatement','TryStatement','SwitchStatement','Block','ExpressionStatement','BreakStatement','ContinueStatement']);
  var LIT=new Set(['StringLiteral','NumericLiteral','BigIntLiteral','TrueKeyword','FalseKeyword','NullKeyword','RegularExpressionLiteral','NoSubstitutionTemplateLiteral']);
  function cat(k){return DECL.has(k)?'decl':EXPR.has(k)?'expr':STMT.has(k)?'stmt':LIT.has(k)?'lit':k==='Identifier'?'id':'other';}
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  var idGen=0;
  function buildHtml(node,depth){
    if(!node)return'';
    var id='n'+(++idGen);
    var hasCh=node.children&&node.children.length>0;
    var indent=(depth*16)+'px';
    var h='<div class="nr" style="padding-left:'+indent+'">';
    if(hasCh){h+='<span class="tog" data-target="'+id+'" onclick="window.tog(this.dataset.target)">▾</span>';}
    else{h+='<span class="sp"></span>';}
    h+='<span class="'+cat(node.kind)+'">'+esc(node.kind)+'</span>';
    if(node.name){h+=' <span class="nm">'+esc(node.name)+'</span>';}
    else if(node.text){h+=' <span class="tx">'+esc(node.text)+'</span>';}
    h+='</div>';
    if(hasCh){
      h+='<div class="children" id="'+id+'">';
      for(var i=0;i<node.children.length;i++){h+=buildHtml(node.children[i],depth+1);}
      h+='</div>';
    }
    return h;
  }
  window.tog=function(id){
    var el=document.getElementById(id);if(!el)return;
    var open=el.style.display!=='none';
    el.style.display=open?'none':'';
    var row=el.previousSibling;
    if(row){var btn=row.querySelector('.tog');if(btn)btn.textContent=open?'▸':'▾';}
  };
  function countNodes(node){if(!node)return 0;var c=1;if(node.children)node.children.forEach(function(ch){c+=countNodes(ch);});return c;}
  function render(args,res){
    var sc=res&&res.structuredContent;
    if(!sc||!sc.ast){document.getElementById('tree').innerHTML='<p class="loading">Waiting for data…</p>';return;}
    if(sc.error){document.getElementById('tree').innerHTML='<div class="err">'+esc(sc.error)+'</div>';notifySize();return;}
    try{
      var total=countNodes(sc.ast);
      var topbar='<span class="stat">Language: <b>'+esc(sc.language)+'</b></span>';
      topbar+='<span class="stat">Nodes: <b>'+total+'</b></span>';
      topbar+='<span class="stat">Lines: <b>'+esc(sc.lineCount)+'</b></span>';
      if(sc.truncated){topbar+='<span class="stat" style="color:#f85149">⚠ Truncated at 400 nodes</span>';}
      document.getElementById('topbar').innerHTML=topbar;
      idGen=0;
      document.getElementById('tree').innerHTML=buildHtml(sc.ast,0);
      notifySize();
    }catch(e){document.getElementById('tree').innerHTML='<div class="err">Render error: '+esc(String(e))+'</div>';notifySize();}
  }
  function notifySize(){setTimeout(function(){notify('ui/notifications/size-changed',{height:document.body.scrollHeight+12});},80);}
  async function init(){
    try{
      document.getElementById('tree').innerHTML='<p class="loading">Initializing…</p>';
      var r1=await request('initialize',{protocolVersion:'2026-01-26',capabilities:{},clientInfo:{name:'ast-explorer',version:'1.0'}});
      if(!r1){throw new Error('No response from initialize');}
      notify('notifications/initialized');
      var r2=await request('ui/initialize',{protocolVersion:'2026-01-26',clientCapabilities:{},clientInfo:{name:'ast-explorer',version:'1.0'}});
      if(!r2){throw new Error('No response from ui/initialize');}
      notify('ui/notifications/initialized');
      document.getElementById('tree').innerHTML='<p class="loading">Waiting for tool result…</p>';
    }catch(e){document.getElementById('tree').innerHTML='<div class="err">Init failed: '+esc(String(e))+'</div>';}
  }
  // Call init() directly — the script is at the end of <body> so the DOM is
  // already parsed. Relying on DOMContentLoaded can race in VS Code webview
  // srcdoc iframes because the event may fire before the listener is added.
  init();
})();
</script>
</body>
</html>`;
}

// MCP App HTML: Code Diff

function getCodeDiffHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--mcp-bg,#0d1117);color:var(--mcp-fg,#e6edf3);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;overflow-x:auto}
.topbar{padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--mcp-border2,#21262d)}
.stat{background:var(--mcp-bg2,#161b22);border:1px solid var(--mcp-border,#30363d);border-radius:5px;padding:3px 10px;font-size:12px;color:var(--mcp-muted,#8b949e)}
.stat b{color:var(--mcp-fg,#e6edf3)}
.stat-add{color:var(--mcp-green,#3fb950);border-color:var(--mcp-green,#3fb950);background:var(--mcp-diff-add,rgba(46,160,67,.12))}
.stat-rem{color:var(--mcp-red,#f85149);border-color:var(--mcp-red,#f85149);background:var(--mcp-diff-rem,rgba(248,81,73,.12))}
.diff-wrap{width:100%;border-top:0}
table.diff{width:100%;border-collapse:collapse;font-family:ui-monospace,'Cascadia Code','Fira Code','Consolas',monospace;font-size:12.5px;line-height:1.65}
.diff td{padding:0;white-space:pre;vertical-align:top}
.ln{width:46px;min-width:46px;max-width:46px;text-align:right;padding:0 10px 0 6px;color:var(--mcp-muted2,#484f58);user-select:none;border-right:1px solid var(--mcp-border2,#21262d);font-size:11.5px;line-height:inherit}
.ln-a{border-right:none}
.sign{width:18px;min-width:18px;text-align:center;padding:0 2px;font-weight:700;user-select:none}
.code{padding:0 14px 0 4px;width:100%;min-width:0}
tr.added td{background:var(--mcp-diff-add,rgba(46,160,67,.12))}
tr.removed td{background:var(--mcp-diff-rem,rgba(248,81,73,.12))}
tr.unchanged td{background:transparent}
tr.hunk td{background:var(--mcp-bg2,#161b22);color:var(--mcp-muted,#8b949e);font-size:11px;padding:3px 0}
tr.added .sign{color:var(--mcp-green,#3fb950)}
tr.removed .sign{color:var(--mcp-red,#f85149)}
tr.unchanged .sign{color:var(--mcp-border,#30363d)}
mark.cm{background:var(--mcp-diff-add-hl,rgba(46,160,67,.45));color:inherit;border-radius:2px;padding:0 1px}
tr.removed mark.cm{background:var(--mcp-diff-rem-hl,rgba(248,81,73,.45))}
tr.added:hover td,tr.removed:hover td{filter:brightness(1.1)}
.loading{color:var(--mcp-muted,#8b949e);font-style:italic;padding:16px}
.err{color:var(--mcp-red,#f85149);padding:10px 16px;background:rgba(248,81,73,.08);margin:8px;border-radius:6px}
.empty-note{color:var(--mcp-muted,#8b949e);padding:16px;font-size:13px}
</style>
</head>
<body>
<div id="topbar" class="topbar"></div>
<div id="diff" class="diff-wrap"><p class="loading">Connecting…</p></div>
<script>
(function(){
  var rid=0,pend={};
  function request(m,p){var id=++rid;return new Promise(function(ok){pend[id]=ok;window.parent.postMessage({jsonrpc:'2.0',id:id,method:m,params:p},'*');});}
  function notify(m,p){window.parent.postMessage({jsonrpc:'2.0',method:m,params:p},'*');}
  window.addEventListener('message',function(ev){
    var msg=ev.data;if(!msg||msg.jsonrpc!=='2.0')return;
    if(msg.id!==undefined&&pend[msg.id]){pend[msg.id](msg.result);delete pend[msg.id];return;}
    if(msg.method==='ui/notifications/tool-result'){render((msg.params||{}).structuredContent);}
  });
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function charDiff(a,b){
    if(a.length>300||b.length>300){return[esc(a),esc(b)];}
    var m=a.length,n=b.length,dp=[],i,j;
    for(i=0;i<=m;i++){dp[i]=new Array(n+1).fill(0);}
    for(i=1;i<=m;i++)for(j=1;j<=n;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);
    var ops=[];i=m;j=n;
    while(i>0||j>0){
      if(i>0&&j>0&&a[i-1]===b[j-1]){ops.push({t:'e',a:a[i-1],b:b[j-1]});i--;j--;}
      else if(j>0&&(i===0||dp[i][j-1]>=dp[i-1][j])){ops.push({t:'i',b:b[j-1]});j--;}
      else{ops.push({t:'d',a:a[i-1]});i--;}
    }
    ops.reverse();
    var hA='',hB='',inA=false,inB=false;
    ops.forEach(function(op){
      if(op.t==='e'){
        if(inA){hA+='</mark>';inA=false;}if(inB){hB+='</mark>';inB=false;}
        hA+=esc(op.a);hB+=esc(op.b);
      } else if(op.t==='d'){
        if(!inA){hA+='<mark class="cm">';inA=true;}hA+=esc(op.a);
      } else {
        if(!inB){hB+='<mark class="cm">';inB=true;}hB+=esc(op.b);
      }
    });
    if(inA)hA+='</mark>';if(inB)hB+='</mark>';
    return[hA,hB];
  }
  var CONTEXT=3;
  function render(sc){
    if(!sc||!sc.lines){document.getElementById('diff').innerHTML='<p class="loading">Waiting…</p>';return;}
    if(sc.error){document.getElementById('diff').innerHTML='<div class="err">'+esc(sc.error)+'</div>';notifySize();return;}
    var lines=sc.lines,added=0,removed=0,unchanged=0;
    lines.forEach(function(l){if(l.type==='added')added++;else if(l.type==='removed')removed++;else unchanged++;});
    var tb='';
    if(sc.label)tb+='<span class="stat"><b>'+esc(sc.label)+'</b></span>';
    tb+='<span class="stat stat-add">+'+added+'</span><span class="stat stat-rem">−'+removed+'</span><span class="stat">'+unchanged+' unchanged</span>';
    document.getElementById('topbar').innerHTML=tb;
    if(lines.length===0){document.getElementById('diff').innerHTML='<p class="empty-note">No differences.</p>';notifySize();return;}
    var cd=new Array(lines.length);
    for(var i=0;i<lines.length-1;i++){
      if(lines[i].type==='removed'&&lines[i+1].type==='added'){var r=charDiff(lines[i].text,lines[i+1].text);cd[i]=r[0];cd[i+1]=r[1];}
    }
    var show=new Array(lines.length).fill(false);
    for(var i=0;i<lines.length;i++)if(lines[i].type!=='unchanged')for(var k=Math.max(0,i-CONTEXT);k<=Math.min(lines.length-1,i+CONTEXT);k++)show[k]=true;
    var h='<table class="diff"><tbody>',lastShown=-1;
    for(var i=0;i<lines.length;i++){
      if(!show[i])continue;
      if(lastShown>=0&&i>lastShown+1){
        var hidden=i-(lastShown+1);
        h+='<tr class="hunk"><td class="ln ln-a"></td><td class="ln"></td><td class="sign"></td><td class="code">@@ '+hidden+' line'+(hidden===1?'':'s')+' unchanged @@</td></tr>';
      }
      var l=lines[i],sign=l.type==='added'?'+':l.type==='removed'?'−':' ';
      var la=l.lineA!=null?l.lineA:'',lb=l.lineB!=null?l.lineB:'';
      var codeHtml=cd[i]!=null?cd[i]:esc(l.text);
      h+='<tr class="'+l.type+'"><td class="ln ln-a">'+la+'</td><td class="ln">'+lb+'</td><td class="sign">'+sign+'</td><td class="code">'+codeHtml+'</td></tr>';
      lastShown=i;
    }
    h+='</tbody></table>';
    document.getElementById('diff').innerHTML=h;
    notifySize();
  }
  function notifySize(){setTimeout(function(){notify('ui/notifications/size-changed',{height:document.body.scrollHeight+12});},80);}
  async function init(){
    try{
      await request('initialize',{protocolVersion:'2026-01-26',capabilities:{},clientInfo:{name:'code-diff',version:'1.0'}});
      notify('notifications/initialized');
      await request('ui/initialize',{protocolVersion:'2026-01-26',clientCapabilities:{},clientInfo:{name:'code-diff',version:'1.0'}});
      notify('ui/notifications/initialized');
    }catch(e){document.getElementById('diff').innerHTML='<div class="err">Init failed: '+esc(String(e))+'</div>';}
  }
  init();
})();
</script>
</body>
</html>`;
}

// MCP App HTML: Server Stats Dashboard
function getServerStatsDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--mcp-bg, #0d1117);
  color: var(--mcp-fg, #e6edf3);
  font-size: 13px;
  background-image: radial-gradient(circle, var(--mcp-border, #30363d) 1px, transparent 1px);
  background-size: 20px 20px;
}
.hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  background: var(--mcp-bg2, #161b22);
  border-bottom: 1px solid var(--mcp-border, #30363d);
  position: sticky; top: 0; z-index: 10;
}
.hdr-l { display: flex; align-items: center; gap: 10px; }
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #3fb950;
  box-shadow: 0 0 8px #3fb950, 0 0 20px rgba(63,185,80,.4);
  animation: pulse-dot 2s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .5; transform: scale(.8); }
}
.srv-name {
  font-size: 14px;
  font-weight: 700;
  font-family: monospace;
  letter-spacing: 1.5px;
  color: var(--mcp-fg, #e6edf3);
}
.uptime { font-size: 11px; color: var(--mcp-muted, #8b949e); font-family: monospace; }
.hdr-r { display: flex; align-items: center; }
.live-badge {
  font-family: monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: #3fb950;
  text-shadow: 0 0 8px #3fb950, 0 0 20px rgba(63,185,80,.5);
  border: 1px solid rgba(63,185,80,.35);
  padding: 2px 8px;
  border-radius: 2px;
  animation: live-pulse 2.5s ease-in-out infinite;
}
@keyframes live-pulse {
  0%, 100% { opacity: 1; text-shadow: 0 0 8px #3fb950, 0 0 20px rgba(63,185,80,.5); }
  50% { opacity: .55; text-shadow: 0 0 3px #3fb950; }
}
.content { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.card {
  background: var(--mcp-bg2, #161b22);
  border: 1px solid var(--mcp-border, #30363d);
  border-radius: 10px; padding: 14px;
  position: relative; overflow: hidden;
}
.card::after {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, var(--mcp-accent, #388bfd), #a78bfa);
  opacity: .6;
}
.card-lbl {
  font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px;
  color: var(--mcp-muted, #8b949e); margin-bottom: 8px;
}
.card-val {
  font-size: 24px; font-weight: 700; font-family: monospace;
  color: var(--mcp-fg, #e6edf3); line-height: 1;
}
.card-val span { font-size: 12px; color: var(--mcp-muted, #8b949e); font-weight: 400; }
.card-sub { font-size: 10px; color: var(--mcp-muted, #8b949e); margin-top: 4px; }
.bar-track {
  height: 5px; background: var(--mcp-border, #30363d);
  border-radius: 3px; margin-top: 10px; overflow: hidden;
}
.bar-fill {
  height: 100%; border-radius: 3px;
  transition: width .7s cubic-bezier(.4,0,.2,1);
  background: linear-gradient(90deg, var(--mcp-accent, #388bfd), #a78bfa);
}
.bar-fill.warn { background: linear-gradient(90deg, #e3b341, #fb923c); }
.bar-fill.ok   { background: linear-gradient(90deg, #3fb950, #34d399); }
.sec-hdr {
  font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px;
  color: var(--mcp-muted, #8b949e);
}
.tools { display: flex; flex-direction: column; gap: 5px; }
.tool-row {
  display: flex; align-items: center; gap: 10px;
  background: var(--mcp-bg2, #161b22);
  border: 1px solid var(--mcp-border, #30363d);
  border-radius: 7px; padding: 7px 12px;
  transition: border-color .2s;
}
.tool-row:hover { border-color: var(--mcp-accent, #388bfd); }
.tool-nm {
  font-family: monospace; font-size: 12px;
  color: var(--mcp-fg, #e6edf3);
  flex: 0 0 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tool-bar-wrap { flex: 1; height: 4px; background: var(--mcp-border, #30363d); border-radius: 2px; overflow: hidden; }
.tool-bar {
  height: 100%; border-radius: 2px;
  transition: width .7s cubic-bezier(.4,0,.2,1);
  background: linear-gradient(90deg, #388bfd, #a78bfa);
}
.tool-cnt { font-family: monospace; font-size: 11px; color: var(--mcp-muted, #8b949e); flex: 0 0 28px; text-align: right; }
.feed { display: flex; flex-direction: column; gap: 4px; }
.idle {
  padding: 32px 0; text-align: center;
  color: var(--mcp-fg2, #8b949e); font-size: 13px; font-style: italic;
}
.feed-row {
  display: flex; align-items: center; gap: 10px;
  background: var(--mcp-bg2, #161b22);
  border: 1px solid var(--mcp-border, #30363d);
  border-radius: 7px; padding: 6px 12px;
}
.feed-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.d-fast { background: #3fb950; box-shadow: 0 0 6px rgba(63,185,80,.6); }
.d-med  { background: #e3b341; box-shadow: 0 0 6px rgba(227,179,65,.6); }
.d-slow { background: #f85149; box-shadow: 0 0 6px rgba(248,81,73,.6); }
.feed-nm { font-family: monospace; font-size: 12px; color: var(--mcp-fg, #e6edf3); flex: 1; }
.feed-ms { font-family: monospace; font-size: 11px; color: var(--mcp-muted, #8b949e); flex: 0 0 48px; text-align: right; }
.feed-ago { font-size: 11px; color: var(--mcp-muted, #8b949e); flex: 0 0 66px; text-align: right; opacity: .7; }
.empty { color: var(--mcp-muted, #8b949e); font-style: italic; font-size: 12px; }
.connecting { text-align: center; padding: 40px 20px; color: var(--mcp-muted, #8b949e); }
.mat-wrap { position: relative; background: #000; border-bottom: 1px solid rgba(0,200,68,.18); overflow: hidden; height: 68px; flex-shrink: 0; }
.mat-lbl { position: absolute; top: 5px; left: 8px; font-family: monospace; font-size: 9px; letter-spacing: 2px; color: #3fb950; text-shadow: 0 0 6px #3fb950; z-index: 1; pointer-events: none; }
#mat-canvas { display: block; width: 100%; height: 68px; }
</style>
</head>
<body>
<div class="hdr" style="display:none">
  <div class="hdr-l">
    <div class="live-dot"></div>
    <span class="srv-name">mcp-test-server</span>
    <span class="uptime" id="uptime-el">connecting…</span>
  </div>
  <div class="hdr-r">
    <span class="live-badge">live</span>
  </div>
</div>
<div class="mat-wrap" id="mat-wrap" style="display:none">
  <span class="mat-lbl">SYS::STREAM</span>
  <canvas id="mat-canvas" height="68"></canvas>
</div>
<div id="root"><div class="idle">Run Tool to load dashboard</div></div>
<script>
(function() {
  var rid = 0, pend = {};
  function request(m, p) {
    var id = ++rid;
    return new Promise(function(resolve) {
      pend[id] = resolve;
      window.parent.postMessage({ jsonrpc: '2.0', id: id, method: m, params: p }, '*');
    });
  }
  function notify(m, p) {
    window.parent.postMessage({ jsonrpc: '2.0', method: m, params: p }, '*');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtUp(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
    if (m > 0) return m + 'm ' + pad(sec) + 's';
    return sec + 's';
  }
  function fmtMB(b) { return (b / 1024 / 1024).toFixed(1); }
  function ago(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'now'; if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  var uptimeBase = 0, uptimeRef = 0, lastH = 0, polling = false, startMatrix = null;
  window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pend[msg.id]) { pend[msg.id](msg.result); delete pend[msg.id]; return; }
    if (msg.method === 'ui/notifications/tool-result' && !polling) {
      var sc = msg.params && msg.params.structuredContent;
      if (sc) {
        polling = true;
        document.querySelector('.hdr').style.display = 'flex';
        document.getElementById('mat-wrap').style.display = 'block';
        if (startMatrix) startMatrix();
        poll();
        setInterval(poll, 3000);
      }
    }
  });
  // Matrix rain — init after layout so offsetWidth is correct
  var MCHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';
  (function() {
    var mc = document.getElementById('mat-canvas');
    if (!mc) return;
    var mctx = mc.getContext('2d'), fs = 12, mdrops = [];
    startMatrix = function() {
      mc.width = mc.offsetWidth || 600;
      var cols = Math.floor(mc.width / fs);
      for (var i = 0; i < cols; i++) mdrops.push(Math.random() * -20);
      setInterval(function() {
        var nc = Math.floor(mc.width / fs);
        while (mdrops.length < nc) mdrops.push(0);
        mdrops = mdrops.slice(0, nc);
        mctx.fillStyle = 'rgba(0,0,0,0.07)';
        mctx.fillRect(0, 0, mc.width, mc.height);
        mctx.font = fs + 'px monospace';
        for (var i = 0; i < mdrops.length; i++) {
          var ch = MCHARS[Math.floor(Math.random() * MCHARS.length)];
          var y = mdrops[i] * fs;
          mctx.fillStyle = '#afffaf'; mctx.fillText(ch, i * fs, y);
          if (mdrops[i] > 1) { mctx.fillStyle = '#00cc44'; mctx.fillText(MCHARS[Math.floor(Math.random() * MCHARS.length)], i * fs, y - fs); }
          if (y > mc.height && Math.random() > 0.95) mdrops[i] = 0;
          mdrops[i] += 0.25;
        }
      }, 33);
    };
    // startMatrix is called from tool-result handler
  })();
  setInterval(function() {
    if (!uptimeRef) return;
    document.getElementById('uptime-el').textContent = '\u2191 ' + fmtUp(uptimeBase + (Date.now() - uptimeRef));
  }, 1000);
  function render(sc) {
    uptimeBase = sc.uptime; uptimeRef = Date.now();
    var rssMB = fmtMB(sc.memory.rss);
    var rssPct = Math.min(100, Math.round(sc.memory.rss / (256 * 1024 * 1024) * 100));
    var h = '<div class="content">';
    h += '<div class="cards">';
    h += '<div class="card"><div class="card-lbl">Active Sessions</div>';
    h += '<div class="card-val">' + sc.sessions + '</div>';
    h += '<div class="card-sub">MCP client' + (sc.sessions !== 1 ? 's' : '') + ' connected</div></div>';
    h += '<div class="card"><div class="card-lbl">RSS Memory</div>';
    h += '<div class="card-val">' + rssMB + '<span> MB</span></div>';
    h += '<div class="card-sub">resident set size</div>';
    h += '<div class="bar-track"><div class="bar-fill ok" style="width:' + rssPct + '%"></div></div></div>';
    h += '<div class="card"><div class="card-lbl">Total Calls</div>';
    h += '<div class="card-val">' + sc.totalCalls + '</div>';
    h += '<div class="card-sub">' + sc.tools.length + ' tool' + (sc.tools.length !== 1 ? 's' : '') + ' active</div></div>';
    h += '</div>';
    h += '<div class="sec-hdr">Tool Activity</div>';
    if (sc.tools.length) {
      var maxC = sc.tools[0].count || 1;
      h += '<div class="tools">';
      sc.tools.slice(0, 8).forEach(function(t) {
        var pct = Math.round(t.count / maxC * 100);
        h += '<div class="tool-row"><div class="tool-nm">' + esc(t.name) + '</div>';
        h += '<div class="tool-bar-wrap"><div class="tool-bar" style="width:' + pct + '%"></div></div>';
        h += '<div class="tool-cnt">' + t.count + '</div></div>';
      });
      h += '</div>';
    } else {
      h += '<p class="empty">No tool calls yet \u2014 invoke some tools to see activity.</p>';
    }
    h += '<div class="sec-hdr">Recent Calls</div>';
    if (sc.recent && sc.recent.length) {
      h += '<div class="feed">';
      sc.recent.slice(0, 10).forEach(function(r) {
        var dc = r.ms < 100 ? 'd-fast' : r.ms < 500 ? 'd-med' : 'd-slow';
        h += '<div class="feed-row"><div class="feed-dot ' + dc + '"></div>';
        h += '<div class="feed-nm">' + esc(r.tool) + '</div>';
        h += '<div class="feed-ms">' + r.ms + 'ms</div>';
        h += '<div class="feed-ago">' + ago(r.ts) + '</div></div>';
      });
      h += '</div>';
    } else {
      h += '<p class="empty">No recent calls yet.</p>';
    }
    h += '</div>';
    document.getElementById('root').innerHTML = h;
    var newH = document.body.scrollHeight + 16;
    if (newH !== lastH) { lastH = newH; notify('ui/notifications/size-changed', { height: newH }); }
  }
  async function poll() {
    try {
      var r = await request('tools/call', { name: 'getServerStats', arguments: {} });
      if (r && r.structuredContent) render(r.structuredContent);
    } catch(e) {}
  }
  async function init() {
    try {
      await request('initialize', { protocolVersion: '2026-01-26', capabilities: {}, clientInfo: { name: 'stats-dashboard', version: '1.0' } });
      notify('notifications/initialized');
      await request('ui/initialize', { protocolVersion: '2026-01-26', clientCapabilities: {}, clientInfo: { name: 'stats-dashboard', version: '1.0' } });
      notify('ui/notifications/initialized');
      // polling starts on first tool-result from host
    } catch(e) {
      document.getElementById('root').innerHTML = '<p style="color:var(--mcp-red,#f85149);padding:20px">Error: ' + esc(String(e)) + '</p>';
    }
  }
  window.addEventListener('DOMContentLoaded', init);
})();
<\/script>
</body>
</html>`;
}

// Create a MCP server
const getServer = () => {
  const server = new McpServer({
    name: 'mcp-test-server',
    version: '1.0.0'
  }, {
    capabilities: {
      logging: {},
      resources: {
        subscribe: true,
      },
    },
  });

  // Register a tool that adds two numbers
  server.registerTool(
    'addNumbers',
    {
      title: 'Addition Tool',  // Display name for UI
      description: 'Adds two numbers and returns the result',
      inputSchema: {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      },
    },
    async ({ a, b }): Promise<CallToolResult> => {
      const sum = a + b;
      return {
        content: [
          {
            type: 'text',
            text: `The sum of ${a} and ${b} is ${sum}.`,
          },
        ],
      };
    }
  );

  // Register a tool that reverses a string
  server.registerTool(
    'reverse',
    {
      title: 'Reverse String',
      description: 'Reverses the provided string',
      inputSchema: {
        text: z.string().describe('The string to reverse'),
      },
    },
    async ({ text }): Promise<CallToolResult> => {
      const reversed = text.split('').reverse().join('');

      return {
        content: [
          {
            type: 'text',
            text: reversed,
          },
        ],
      };
    }
  );

  server.registerTool(
    'formatText',
    {
      title: 'Format Text',
      description: 'Formats text with uppercase and a selected style',
      inputSchema: {
        text: z.string().describe('The text to format'),
        uppercase: z.boolean().optional().describe('True for uppercase, false for lowercase, unset to keep the original text'),
        style: z.enum(['plain', 'brackets', 'stars']).describe('The formatting style'),
      },
    },
    async ({ text, uppercase, style }): Promise<CallToolResult> => {
      let baseText = text;

      if (uppercase === true) {
        baseText = text.toUpperCase();
      } else if (uppercase === false) {
        baseText = text.toLowerCase();
      }

      let formattedText = baseText;

      switch (style) {
        case 'brackets':
          formattedText = `[${baseText}]`;
          break;
        case 'stars':
          formattedText = `*** ${baseText} ***`;
          break;
        default:
          formattedText = baseText;
          break;
      }

      return {
        content: [
          {
            type: 'text',
            text: formattedText,
          },
        ],
      };
    }
  );

  server.registerTool(
    'pixelBadge',
    {
      title: 'Pixel Badge',
      description: 'Returns a small test badge as text and image content',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">',
        '<rect width="240" height="80" rx="14" fill="#1f2937"/>',
        '<rect x="8" y="8" width="224" height="64" rx="10" fill="#0ea5e9"/>',
        '<circle cx="42" cy="40" r="16" fill="#f59e0b"/>',
        '<text x="72" y="34" font-family="Arial, sans-serif" font-size="14" fill="#082f49">MCP TEST</text>',
        '<text x="72" y="54" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">PIXEL BADGE</text>',
        '</svg>'
      ].join('');

      const imageData = Buffer.from(svg, 'utf8').toString('base64');

      return {
        content: [
          {
            type: 'text',
            text: 'Pixel Badge generated successfully.',
          },
          {
            type: 'image',
            data: imageData,
            mimeType: 'image/svg+xml',
          },
        ],
      };
    }
  );

  // Register a tool that fetches GitHub repository stats
  server.registerTool(
    'getGitHubRepoStats',
    {
      title: 'GitHub Repo Stats',
      description: 'Fetches star and fork count from a GitHub repository',
      inputSchema: {
        owner: z.string().describe('GitHub username or organization'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }): Promise<CallToolResult> => {
      const url = `https://api.github.com/repos/${owner}/${repo}`;
      const response = await fetch(url);

      if (!response.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to fetch repo stats: ${response.statusText}`,
            },
          ],
        };
      }

      const data = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: `📊 ${owner}/${repo} has ⭐ ${data.stargazers_count} stars and 🍴 ${data.forks_count} forks.`,
          },
        ],
      };
    }
  );

    // Register a tool that returns Hilbert Hotel details
  server.registerTool(
    'getHilbertHotelInfo',
    {
      title: 'Hilbert Hotel Info',
      description: 'Get information about the Hilbert Hotel in Math Town',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const structuredContent = {
        hotelName: 'Hilbert Hotel',
        address: {
          street: '1 Infinity Loop',
          city: 'Math Town',
          postalCode: `MT-${Math.floor(1000 + Math.random() * 9000)}`,
          country: 'Numberland',
        },
        building: {
          floors: Math.floor(50 + Math.random() * 151),
          occupiedRooms: Math.floor(1000 + Math.random() * 9000),
          elevatorCount: Math.floor(2 + Math.random() * 8),
        },
        metadata: {
          requestId: `hilbert-${Math.floor(100000 + Math.random() * 900000)}`,
          generatedAt: new Date().toISOString(),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    }
  );

  server.registerTool(
    'runProgressDemo',
    {
      title: 'Run Progress Demo',
      description: 'Counts through several steps and emits notifications/progress updates when requested by the client',
      inputSchema: {
        steps: z.number().int().min(1).max(20).default(5).describe('How many progress steps to emit'),
        delayMs: z.number().int().min(50).max(2000).default(250).describe('Delay between progress notifications in milliseconds'),
      },
    },
    async ({ steps, delayMs }, extra): Promise<CallToolResult> => {
      for (let index = 1; index <= steps; index += 1) {
        if (extra.signal.aborted) {
          return {
            content: [
              {
                type: 'text',
                text: `Progress demo cancelled at step ${index}.`,
              },
            ],
            isError: true,
          };
        }

        if (extra._meta?.progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: extra._meta.progressToken,
              progress: index,
              total: steps,
              message: `Progress step ${index}/${steps}`,
            },
          });
        }

        await sleep(delayMs);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Progress demo finished with ${steps} steps and ${delayMs}ms delay.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'pushLiveUpdate',
    {
      title: 'Push Live Update',
      description: 'Updates the live demo resource and emits notifications/resources/updated plus a logging message',
      inputSchema: {
        message: z.string().min(1).max(200).describe('Message written into the live resource'),
        broadcast: z.boolean().default(false).describe('True to send the update to all sessions, false for the current session only'),
      },
    },
    async ({ message, broadcast }, extra): Promise<CallToolResult> => {
      const targetSessionIds = broadcast || !extra.sessionId ? undefined : [extra.sessionId];
      await emitLiveUpdate(message, 'pushLiveUpdate', targetSessionIds);

      return {
        content: [
          {
            type: 'text',
            text: broadcast
              ? `Live update broadcast to ${sessions.size} session(s).`
              : `Live update sent for session ${extra.sessionId ?? 'n/a'}.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'startEventBurst',
    {
      title: 'Start Event Burst',
      description: 'Starts a short timer that emits live resource update notifications after the tool has already returned',
      inputSchema: {
        ticks: z.number().int().min(1).max(20).default(5).describe('Number of timed notifications to emit'),
        delayMs: z.number().int().min(100).max(5000).default(1000).describe('Delay between emitted events in milliseconds'),
      },
    },
    async ({ ticks, delayMs }, extra): Promise<CallToolResult> => {
      if (!extra.sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'No session ID is bound to this request. Initialize a stateful session first.',
            },
          ],
          isError: true,
        };
      }

      const started = startEventBurst(extra.sessionId, ticks, delayMs);

      if (!started) {
        return {
          content: [
            {
              type: 'text',
              text: `Session ${extra.sessionId} is no longer active.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Event burst started for session ${extra.sessionId}. Keep the GET /mcp SSE stream open to receive ${ticks} events.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'toggleDynamicCatalog',
    {
      title: 'Toggle Dynamic Catalog',
      description: 'Enables or disables demo resource, prompt, and tool entries so clients can observe list_changed notifications',
      inputSchema: {
        resource: z.boolean().optional().describe('Enable or disable the dynamic demo resource'),
        prompt: z.boolean().optional().describe('Enable or disable the dynamic demo prompt'),
        tool: z.boolean().optional().describe('Enable or disable the dynamic demo tool'),
      },
    },
    async ({ resource, prompt, tool }, extra): Promise<CallToolResult> => {
      if (!extra.sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'No session ID is bound to this request. Initialize a stateful session first.',
            },
          ],
          isError: true,
        };
      }

      const context = sessions.get(extra.sessionId);

      if (!context) {
        return {
          content: [
            {
              type: 'text',
              text: `Session ${extra.sessionId} is no longer active.`,
            },
          ],
          isError: true,
        };
      }

      const changes: string[] = [];

      if (typeof resource === 'boolean') {
        changes.push(`resource=${setEnabledState(context.dynamicResource, resource)}`);
      }

      if (typeof prompt === 'boolean') {
        changes.push(`prompt=${setEnabledState(context.dynamicPrompt, prompt)}`);
      }

      if (typeof tool === 'boolean') {
        changes.push(`tool=${setEnabledState(context.dynamicTool, tool)}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: changes.length > 0
              ? `Dynamic catalog updated for session ${extra.sessionId}: ${changes.join(', ')}`
              : 'No catalog flags changed. Provide at least one of resource, prompt, or tool.',
          },
        ],
      };
    }
  );

  const RESORCERER_URI = 'resource://mcp-test-server/resorcerer';
  const dynamicResource = server.registerResource(
    'dynamic-note',
    DYNAMIC_RESOURCE_URI,
    {
      title: 'Dynamic Note',
      description: 'Only visible when enabled via toggleDynamicCatalog',
      mimeType: 'text/markdown',
    },
    async (): Promise<ReadResourceResult> => {
      const resourceText = [
        '# Dynamic Note',
        '',
        'This resource exists to test notifications/resources/list_changed.',
        '',
        `Version: ${liveState.version}`,
        `Updated At: ${liveState.updatedAt}`,
      ].join('\n');

      return {
        contents: [
          {
            uri: DYNAMIC_RESOURCE_URI,
            mimeType: 'text/markdown',
            text: resourceText,
          },
        ],
      };
    }
  );

  dynamicResource.disable();

  server.registerResource(
    'live-status',
    LIVE_RESOURCE_URI,
    {
      title: 'Live Status',
      description: 'Live-updating demo resource for notifications/resources/updated tests',
      mimeType: 'application/json',
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: LIVE_RESOURCE_URI,
            mimeType: 'application/json',
            text: JSON.stringify({
              ...liveState,
              activeSessions: sessions.size,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'resorcerer',
    RESORCERER_URI,
    {
      title: 'Resorcerer',
      description: 'Provides a compact overview of the demo server capabilities',
      mimeType: 'text/markdown',
    },
    async (): Promise<ReadResourceResult> => {
      const resourceText = [
        '# Resorcerer',
        '',
        'This resource describes the MCP demo server surface in one place.',
        '',
        '## Tools',
        '- addNumbers',
        '- reverse',
        '- formatText',
        '- pixelBadge',
        '- getGitHubRepoStats',
        '- getHilbertHotelInfo',
        '- runProgressDemo',
        '- pushLiveUpdate',
        '- startEventBurst',
        '- toggleDynamicCatalog',
        '- dynamicEcho (optional)',
        '',
        '## Resources',
        '- resorcerer',
        '- live-status',
        '- dynamic-note (optional)',
        '',
        '## Prompts',
        '- promptsmith',
        '- ticket-summary',
        '- dynamic-event-brief (optional)',
        '',
        `Generated at: ${new Date().toISOString()}`,
      ].join('\n');

      return {
        contents: [
          {
            uri: RESORCERER_URI,
            mimeType: 'text/markdown',
            text: resourceText,
          },
        ],
      };
    }
  );

  const dynamicPrompt = server.registerPrompt(
    'dynamic-event-brief',
    {
      title: 'Dynamic Event Brief',
      description: 'Only visible when enabled via toggleDynamicCatalog',
      argsSchema: {
        topic: z.string().describe('Topic for the dynamic prompt'),
      },
    },
    async ({ topic }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Create a short event brief.',
                `Topic: ${topic}`,
                `Current live version: ${liveState.version}`,
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  dynamicPrompt.disable();

  server.registerPrompt(
    'promptsmith',
    {
      title: 'Promptsmith',
      description: 'Builds a reusable prompt brief for a task, audience, and tone',
      argsSchema: {
        goal: z.string().describe('The task or outcome the prompt should achieve'),
        audience: z.string().optional().describe('Who the resulting prompt is meant for'),
        tone: completable(
          z.enum(['clear', 'friendly', 'formal', 'concise']).default('clear').describe('Desired tone of the prompt'),
          async (value) => {
            const tones = ['clear', 'friendly', 'formal', 'concise'] as const;
            const prefix = value?.toLowerCase() ?? '';

            return tones.filter((tone) => tone.startsWith(prefix));
          }
        ),
      },
    },
    async ({ goal, audience, tone }): Promise<GetPromptResult> => {
      const selectedAudience = audience ?? 'a technically literate user';
      const selectedTone = tone;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Create a reusable prompt with the following requirements.',
                `Goal: ${goal}`,
                `Audience: ${selectedAudience}`,
                `Tone: ${selectedTone}`,
                'Return the result with three sections: system prompt, user prompt template, and variables.',
                'Keep the wording specific, concise, and ready to reuse.',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'ticket-summary',
    {
      title: 'Ticket Summary',
      description: 'Creates a concise summary for a support ticket',
      argsSchema: {
        ticketText: z.string().describe('Original support ticket text'),
        audience: completable(
          z.enum(['developer', 'support', 'customer']).describe('Target audience'),
          async (value) => {
            const audiences = ['developer', 'support', 'customer'] as const;
            const prefix = value?.toLowerCase() ?? '';

            return audiences.filter((audience) => audience.startsWith(prefix));
          }
        ),
        style: completable(
          z.enum(['short', 'detailed']).default('short').describe('Summary style'),
          async (value) => {
            const styles = ['short', 'detailed'] as const;
            const prefix = value?.toLowerCase() ?? '';

            return styles.filter((style) => style.startsWith(prefix));
          }
        ),
      },
    },
    async ({ ticketText, audience, style }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Summarize the following support ticket.',
                `Audience: ${audience}`,
                `Style: ${style}`,
                '',
                'Ticket:',
                ticketText,
                '',
                'Return:',
                '- short summary',
                '- main problem',
                '- next action',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  // Register AST Explorer (MCP App)
  const AST_UI = 'ui://mcp-test-server/ast-explorer';

  server.registerTool(
    'exploreAst',
    {
      title: 'AST Explorer',
      description: 'Parses TypeScript or JavaScript code and renders the Abstract Syntax Tree as an interactive collapsible tree',
      inputSchema: {
        code: z.string().describe('TypeScript or JavaScript source code to parse'),
        language: z.enum(['typescript', 'javascript']).default('typescript').describe('Source language'),
      },
      // @ts-ignore — _meta is part of MCP protocol (spec 2026-01-26) but not yet typed in SDK
      _meta: { ui: { resourceUri: AST_UI } },
    },
    async ({ code, language }): Promise<CallToolResult> => {
      const scriptKind = language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const sf = ts.createSourceFile('input.' + (language === 'javascript' ? 'js' : 'ts'), code, ts.ScriptTarget.Latest, true, scriptKind);
      const budget = { left: 400 };
      const ast = simplifyAst(sf, sf, 0, budget);
      const truncated = budget.left <= 0;
      const lineCount = code.split('\n').length;
      const structuredContent = { language, lineCount, truncated, ast };
      const summary = `AST for ${lineCount}-line ${language} snippet — ${truncated ? 'truncated at 400 nodes' : 'fully parsed'}`;
      return { content: [{ type: 'text', text: summary }], structuredContent } as CallToolResult & { structuredContent: unknown };
    }
  );

  server.registerResource(
    'ast-explorer-ui',
    AST_UI,
    { title: 'AST Explorer UI', description: 'MCP App iframe for AST visualization', mimeType: 'text/html' },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: AST_UI, mimeType: 'text/html', text: getAstExplorerHtml() }],
    })
  );

  // Register Code Diff (MCP App)
  const DIFF_UI = 'ui://mcp-test-server/code-diff';

  server.registerTool(
    'diffCode',
    {
      title: 'Code Diff',
      description: 'Computes a line-by-line diff between two code snippets and renders a visual unified diff with syntax-highlighted changes',
      inputSchema: {
        before: z.string().describe('Original code (left / old version)'),
        after: z.string().describe('Modified code (right / new version)'),
        label: z.string().optional().describe('Optional label for the diff header'),
      },
      // @ts-ignore — _meta is part of MCP protocol (spec 2026-01-26) but not yet typed in SDK
      _meta: { ui: { resourceUri: DIFF_UI } },
    },
    async ({ before, after, label }): Promise<CallToolResult> => {
      const MAX = 300;
      const linesA = before.split('\n');
      const linesB = after.split('\n');
      if (linesA.length > MAX || linesB.length > MAX) {
        const structuredContent = { error: `Input too large (max ${MAX} lines per snippet). Got ${linesA.length} / ${linesB.length} lines.`, lines: [] };
        return { content: [{ type: 'text', text: structuredContent.error }], structuredContent } as CallToolResult & { structuredContent: unknown };
      }
      const lines = computeDiff(linesA, linesB);
      const added = lines.filter(l => l.type === 'added').length;
      const removed = lines.filter(l => l.type === 'removed').length;
      const structuredContent = { label: label ?? 'Diff', lines, stats: { added, removed, unchanged: lines.length - added - removed } };
      const summary = `${label ? label + ': ' : ''}+${added} / −${removed} across ${linesA.length}→${linesB.length} lines`;
      return { content: [{ type: 'text', text: summary }], structuredContent } as CallToolResult & { structuredContent: unknown };
    }
  );

  server.registerResource(
    'code-diff-ui',
    DIFF_UI,
    { title: 'Code Diff UI', description: 'MCP App iframe for code diff visualization', mimeType: 'text/html' },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: DIFF_UI, mimeType: 'text/html', text: getCodeDiffHtml() }],
    })
  );

  // Register Regex Visualizer (MCP App with ui:// resource)
  const REGEX_VIZ_UI = 'ui://mcp-test-server/regex-visualizer';

  server.registerTool(
    'visualizeRegex',
    {
      title: 'Regex Visualizer',
      description: 'Parses a regular expression and renders an interactive token breakdown with optional match highlighting',
      inputSchema: {
        pattern: z.string().describe('Regular expression pattern (without delimiters, e.g. "^hello\\s+world$")'),
        flags: z.string().optional().describe('Regex flags, e.g. "gi"'),
        testString: z.string().optional().describe('Optional string to test the regex against'),
      },
      // @ts-ignore — _meta is part of MCP protocol (spec 2026-01-26) but not yet typed in SDK
      _meta: { ui: { resourceUri: REGEX_VIZ_UI } },
    },
    async ({ pattern, flags, testString }): Promise<CallToolResult> => {
      const flagStr = flags ?? '';
      let isValid = true;
      let error: string | undefined;
      let tokens: RegexToken[] = [];
      let matchResult: unknown = null;
      try {
        const re = new RegExp(pattern, flagStr);
        tokens = tokenizeRegex(pattern);
        if (testString !== undefined) {
          const match = re.exec(testString);
          if (match) {
            matchResult = {
              matched: true,
              fullMatch: match[0],
              index: match.index,
              groups: match.slice(1).map((g, i) => ({ index: i + 1, value: g })),
              namedGroups: match.groups ?? {},
            };
          } else {
            matchResult = { matched: false };
          }
        }
      } catch (e) {
        isValid = false;
        error = e instanceof Error ? e.message : String(e);
      }
      const structuredContent = {
        pattern,
        flags: flagStr,
        isValid,
        ...(error !== undefined ? { error } : {}),
        tokens,
        ...(testString !== undefined ? { testString } : {}),
        ...(matchResult !== null ? { matchResult } : {}),
      };
      const summary = isValid
        ? `/${pattern}/${flagStr} — ${tokens.length} tokens${testString !== undefined ? ((matchResult as { matched: boolean }).matched ? ', match found' : ', no match') : ''}`
        : `Invalid regex: ${error}`;
      return { content: [{ type: 'text', text: summary }], structuredContent } as CallToolResult & { structuredContent: unknown };
    }
  );

  server.registerResource(
    'regex-visualizer-ui',
    REGEX_VIZ_UI,
    { title: 'Regex Visualizer UI', description: 'MCP App iframe for regex visualization', mimeType: 'text/html' },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: REGEX_VIZ_UI, mimeType: 'text/html', text: getRegexVisualizerHtml() }],
    })
  );

  // Register Fractal Explorer (MCP App with ui:// resource)
  const FRACTAL_UI = 'ui://mcp-test-server/fractal-explorer';

  server.registerTool(
    'exploreFractal',
    {
      title: 'Fractal Explorer',
      description: 'Renders a Mandelbrot or Julia set fractal with full interactivity (click canvas to zoom in)',
      inputSchema: {
        type: z.enum(['mandelbrot', 'julia']).default('mandelbrot').describe('Fractal type'),
        palette: z.enum(['electric', 'fire', 'ocean', 'aurora', 'gold']).default('electric').describe('Color palette'),
        centerX: z.number().default(-0.5).describe('Real part of the center point'),
        centerY: z.number().default(0).describe('Imaginary part of the center point'),
        zoom: z.number().min(0.1).max(1e12).default(1).describe('Zoom level (1 = default view, doubles each step)'),
        maxIterations: z.number().int().min(50).max(2000).default(300).describe('Max iterations — higher = more detail but slower render'),
        juliaRe: z.number().default(-0.7269).describe('Real part of Julia constant c (only for type=julia)'),
        juliaIm: z.number().default(0.1889).describe('Imaginary part of Julia constant c (only for type=julia)'),
      },
      // @ts-ignore — _meta is part of MCP protocol (spec 2026-01-26) but not yet typed in SDK
      _meta: { ui: { resourceUri: FRACTAL_UI } },
    },
    async ({ type, palette, centerX, centerY, zoom, maxIterations, juliaRe, juliaIm }): Promise<CallToolResult> => {
      const structuredContent = {
        type,
        palette,
        center: { x: centerX, y: centerY },
        zoom,
        maxIterations,
        ...(type === 'julia' ? { juliaC: { re: juliaRe, im: juliaIm } } : {}),
      };
      const desc = type === 'mandelbrot'
        ? `Mandelbrot set — center (${centerX}, ${centerY}i), zoom ${zoom}×, ${maxIterations} iters, palette: ${palette}`
        : `Julia set c=(${juliaRe}+${juliaIm}i) — center (${centerX}, ${centerY}i), zoom ${zoom}×, ${maxIterations} iters, palette: ${palette}`;
      return { content: [{ type: 'text', text: desc }], structuredContent } as CallToolResult & { structuredContent: unknown };
    }
  );

  server.registerResource(
    'fractal-explorer-ui',
    FRACTAL_UI,
    { title: 'Fractal Explorer UI', description: 'MCP App iframe for fractal rendering', mimeType: 'text/html' },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: FRACTAL_UI, mimeType: 'text/html', text: getFractalExplorerHtml() }],
    })
  );

  const dynamicTool = server.registerTool(
    'dynamicEcho',
    {
      title: 'Dynamic Echo',
      description: 'Only visible when enabled via toggleDynamicCatalog',
      inputSchema: {
        text: z.string().describe('Text to echo back'),
      },
    },
    async ({ text }): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: 'text',
            text: `Dynamic echo: ${text}`,
          },
        ],
      };
    }
  );

  dynamicTool.disable();

  // Register Server Stats Dashboard (MCP App)
  const STATS_UI = 'ui://mcp-test-server/server-stats';
  server.registerTool(
    'getServerStats',
    {
      title: 'Server Stats',
      description: 'Live server dashboard: uptime, memory usage, and per-tool call counts',
      inputSchema: {},
      // @ts-ignore
      _meta: { ui: { resourceUri: STATS_UI } },
    },
    async (): Promise<CallToolResult> => {
      const mem = process.memoryUsage();
      const tools = Array.from(serverStats.callCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      const structuredContent = {
        uptime: Date.now() - serverStats.startTime,
        memory: { rss: mem.rss },
        sessions: sessions.size,
        totalCalls: tools.reduce((s, t) => s + t.count, 0),
        tools,
        recent: serverStats.recent.slice(0, 20),
      };
      const upSec = Math.floor(structuredContent.uptime / 1000);
      return {
        content: [{ type: 'text', text: `Server up ${upSec}s, ${structuredContent.totalCalls} total calls` }],
        structuredContent,
      } as CallToolResult & { structuredContent: unknown };
    }
  );

  server.registerResource(
    'server-stats-ui',
    STATS_UI,
    { title: 'Server Stats UI', description: 'Live MCP App dashboard for server statistics', mimeType: 'text/html' },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: STATS_UI, mimeType: 'text/html', text: getServerStatsDashboardHtml() }],
    })
  );

  // Spec-konformes resources/subscribe und resources/unsubscribe
  server.server.setRequestHandler(SubscribeRequestSchema, async (req, extra) => {
    const uri = req.params.uri;
    const sid = extra.sessionId;
    if (sid) {
      if (!subscriptions.has(uri)) subscriptions.set(uri, new Set());
      subscriptions.get(uri)!.add(sid);
    }
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req, extra) => {
    const uri = req.params.uri;
    const sid = extra.sessionId;
    if (sid) subscriptions.get(uri)?.delete(sid);
    return {};
  });

  return {
    server,
    dynamicResource,
    dynamicPrompt,
    dynamicTool,
  };
};


// Start server with HTTP transport
async function startHttpServer() {
  console.log('🚀 Starting MCP server with HTTP transport...');
  
  const app = express();

  const cors = require('cors')
  app.use(cors()); // enabling CORS for any unknown origin

  app.use(express.json());

  // Track tool call stats for the Server Stats Dashboard (MCP App)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST') {
      const body = req.body as Record<string, unknown> | undefined;
      if (body?.method === 'tools/call') {
        const toolName = (body.params as Record<string, unknown> | undefined)?.name as string | undefined;
        if (toolName && toolName !== 'getServerStats') {
          const t0 = Date.now();
          res.on('finish', () => {
            serverStats.callCounts.set(toolName, (serverStats.callCounts.get(toolName) ?? 0) + 1);
            serverStats.recent.unshift({ tool: toolName, ms: Date.now() - t0, ts: Date.now() });
            if (serverStats.recent.length > 30) serverStats.recent.pop();
          });
        }
      }
    }
    next();
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);
    console.log('Received MCP POST request:', req.body);

    try {
      if (sessionId) {
        const context = sessions.get(sessionId);

        if (!context) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: `Session ${sessionId} not found.`,
            },
            id: null,
          });
          return;
        }

        await context.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: initialize must be called before session-bound requests.',
          },
          id: null,
        });
        return;
      }

      const serverContext = getServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, {
            ...serverContext,
            transport,
          });
          console.log(`Session initialized: ${initializedSessionId}`);
        },
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId;

        if (!closedSessionId) {
          return;
        }

        const context = sessions.get(closedSessionId);

        if (!context) {
          return;
        }

        stopEventTimer(context);
        removeSessionSubscriptions(closedSessionId);
        sessions.delete(closedSessionId);
        void context.server.close();
        console.log(`Session closed: ${closedSessionId}`);
      };

      await serverContext.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);

    if (!sessionId) {
      res.status(400).send('Missing mcp-session-id header.');
      return;
    }

    const context = sessions.get(sessionId);

    if (!context) {
      res.status(404).send(`Session ${sessionId} not found.`);
      return;
    }

    console.log(`Establishing GET SSE stream for session ${sessionId}`);
    res.on('close', () => {
      const ctx = sessions.get(sessionId);
      if (ctx) {
        stopEventTimer(ctx);
        removeSessionSubscriptions(sessionId);
        sessions.delete(sessionId);
        void ctx.server.close();
        console.log(`Session closed (SSE dropped): ${sessionId}`);
      }
    });
    await context.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);

    if (!sessionId) {
      res.status(400).send('Missing mcp-session-id header.');
      return;
    }

    const context = sessions.get(sessionId);

    if (!context) {
      res.status(404).send(`Session ${sessionId} not found.`);
      return;
    }

    console.log(`Received DELETE request for session ${sessionId}`);
    await context.transport.handleRequest(req, res);
  });

  const httpServer = app.listen(MCP_PORT);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });

  console.log(`✅ MCP Streamable HTTP Server listening on port ${MCP_PORT}`);

  // Handle server shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down HTTP server...');
    httpServer.close(() => process.exit(0));
  });
}

// Main function to start the server
async function main() {
    await startHttpServer();
}

// Start the server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

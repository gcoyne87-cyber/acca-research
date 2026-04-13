const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── 1. Add onclick handlers to tomorrow venue cards ───────────────────────────
const cardStyle='"flex-shrink:0;width:185px;height:145px;border-radius:12px;overflow:hidden;position:relative;border:1px solid #e4e8f0;cursor:pointer">';
const venues=[
  {name:'Cheltenham',id:'cheltenham'},
  {name:'Punchestown',id:'punchestown'},
  {name:'Navan',id:'navan'},
  {name:'Southwell',id:'southwell'}
];
venues.forEach(function(v){
  const nameIdx=html.indexOf('>'+v.name+'<');
  if(nameIdx<0){console.error('FAIL: '+v.name+' not found');process.exit(1);}
  const cardIdx=html.lastIndexOf('<div style='+cardStyle,nameIdx);
  if(cardIdx<0){console.error('FAIL: card div for '+v.name+' not found');process.exit(1);}
  const oldCard='<div style='+cardStyle;
  const newCard='<div onclick="navigateToTomorrowMeeting(\''+v.id+'\')" style='+cardStyle;
  html=html.slice(0,cardIdx)+newCard+html.slice(cardIdx+oldCard.length);
  console.log('1. onclick -> '+v.name);
});

// ── 2. Wire up inline tomorrow container with pill bar + list ─────────────────
const oldInline='<div id="racing-tomorrow-inline-meeting" style="max-height:0;overflow:hidden;transition:max-height 0.35s ease"></div>';
const newInline=
  '<div id="racing-tomorrow-inline-meeting" style="max-height:0;overflow:hidden;transition:max-height 0.35s ease">'
  +'<div id="tm-inline-venue-pill-bar" style="display:flex;gap:8px;overflow-x:auto;padding:8px 12px 6px;scrollbar-width:none;-webkit-overflow-scrolling:touch"></div>'
  +'<div id="tm-inline-meetings-list"></div>'
  +'</div>';
if(!html.includes(oldInline)){console.error('FAIL: racing-tomorrow-inline-meeting not found');process.exit(1);}
html=html.replace(oldInline,newInline);
console.log('2. Inline tomorrow container wired up');

// ── 3. Insert JS AFTER all HTML changes (so scriptEnd is accurate) ────────────
const scriptEnd=html.lastIndexOf('</script>');

const tmCode=
"\r\n\r\nvar TM_MEETINGS=[\r\n\r\n"+
"  {id:'cheltenham',flag:'GB',name:'Cheltenham',going:'Good to Soft',feature:true,nextMins:0,\r\n"+
"   insights:[\r\n"+
"     'Henderson saddles 3 runners -- 47% win rate at Cheltenham on Good to Soft this season',\r\n"+
"     'Grade 1 novice chaser from Nicholls yard in 14:30 -- market expected to shorten at the off',\r\n"+
"     'Going Good to Soft suits staying chasers -- 4 of last 5 winners went 3m+',\r\n"+
"     '13:45 Handicap Hurdle -- low weights favoured here in last 3 renewals'\r\n"+
"   ],\r\n"+
"   races:[\r\n"+
"    {t:'13:15',r:10,name:'Cheltenham Nov Hrd',dist:'2m5f'},\r\n"+
"    {t:'13:50',r:14,name:'Cheltenham Hcap Chase',dist:'3m2f'},\r\n"+
"    {t:'14:25',r:8,name:'Cheltenham Mares Chase',dist:'2m4f'},\r\n"+
"    {t:'15:00',r:12,name:'Cheltenham Nov Chase',dist:'3m'},\r\n"+
"    {t:'15:35',r:9,name:'Cheltenham Hurdle',dist:'2m1f'},\r\n"+
"    {t:'16:10',r:11,name:'Cheltenham Hcap Hrd',dist:'2m4f'},\r\n"+
"    {t:'16:45',r:7,name:'Cheltenham Chase',dist:'3m1f'}\r\n"+
"  ]},\r\n\r\n"+
"  {id:'punchestown',flag:'IE',name:'Punchestown',going:'Yielding',feature:false,nextMins:0,\r\n"+
"   insights:[\r\n"+
"     'Mullins 52% strike rate at Punchestown on Yielding -- 4 runners declared today',\r\n"+
"     'Staying hurdles suit hold-up horses -- 3 of last 5 winners came from off the pace',\r\n"+
"     'Grade 2 novice chase -- 2 unbeaten novices clash, set for a market move at the off'\r\n"+
"   ],\r\n"+
"   races:[\r\n"+
"    {t:'13:30',r:11,name:'Punchestown Nov Chase',dist:'2m4f'},\r\n"+
"    {t:'14:05',r:9,name:'Punchestown Hurdle',dist:'2m'},\r\n"+
"    {t:'14:40',r:12,name:'Punchestown Hcap',dist:'3m'},\r\n"+
"    {t:'15:15',r:8,name:'Punchestown Mares Hrd',dist:'2m4f'},\r\n"+
"    {t:'15:50',r:10,name:'Punchestown Chase',dist:'2m5f'},\r\n"+
"    {t:'16:25',r:7,name:'Punchestown Bumper',dist:'2m'},\r\n"+
"    {t:'17:00',r:9,name:'Punchestown Nov Hrd',dist:'2m1f'}\r\n"+
"  ]},\r\n\r\n"+
"  {id:'navan',flag:'IE',name:'Navan',going:'Heavy',feature:false,nextMins:0,\r\n"+
"   insights:[\r\n"+
"     'Heavy going at Navan -- strong stayers dominate, avoid hold-up horses on this track',\r\n"+
"     'Elliott 3 runners -- 39% Navan strike rate, particularly strong in staying chases',\r\n"+
"     'Low draw advantage on Heavy here -- horses drawn 1-4 win 58% of races over 2m+'\r\n"+
"   ],\r\n"+
"   races:[\r\n"+
"    {t:'13:40',r:8,name:'Navan Nov Chase',dist:'2m4f'},\r\n"+
"    {t:'14:15',r:11,name:'Navan Hcap Hrd',dist:'2m'},\r\n"+
"    {t:'14:50',r:9,name:'Navan Chase',dist:'3m'},\r\n"+
"    {t:'15:25',r:7,name:'Navan Hurdle',dist:'2m4f'},\r\n"+
"    {t:'16:00',r:10,name:'Navan Flat Race',dist:'2m'},\r\n"+
"    {t:'16:35',r:8,name:'Navan Nov Hrd',dist:'2m1f'}\r\n"+
"  ]},\r\n\r\n"+
"  {id:'southwell',flag:'GB',name:'Southwell',going:'Standard (AW)',feature:false,nextMins:0,\r\n"+
"   insights:[\r\n"+
"     'All-weather specialist in the 14:20 -- won twice on Fibresand here in last 12 months',\r\n"+
"     'Hold-up horses win 67% on Fibresand at Southwell -- pace will be fast, sit off it',\r\n"+
"     'Haggas 3 runners -- 44% Southwell all-weather strike rate this season'\r\n"+
"   ],\r\n"+
"   races:[\r\n"+
"    {t:'13:45',r:9,name:'Southwell Hcap',dist:'1m'},\r\n"+
"    {t:'14:20',r:11,name:'Southwell Stakes',dist:'1m2f'},\r\n"+
"    {t:'14:55',r:8,name:'Southwell Nov Stakes',dist:'7f'},\r\n"+
"    {t:'15:30',r:10,name:'Southwell Hcap',dist:'1m4f'},\r\n"+
"    {t:'16:05',r:7,name:'Southwell Stakes',dist:'6f'},\r\n"+
"    {t:'16:40',r:9,name:'Southwell Claiming',dist:'1m'},\r\n"+
"    {t:'17:15',r:6,name:'Southwell Bumper',dist:'2m'}\r\n"+
"  ]}\r\n\r\n"+
"];\r\n\r\n"+
"var TM_RUNNERS=[\r\n"+
"  {n:3,name:'Constitution Hill',jockey:'N. de Boinville',trainer:'N. Henderson',price:'5/4',pick:true,form:'1-1111',silk:{body:'#1a3a8f',sleeve:'#ffffff',cap:'#c9a84c'}},\r\n"+
"  {n:1,name:'Energumene',jockey:'P. Townend',trainer:'W.P. Mullins',price:'7/2',pick:false,form:'1-2121',silk:{body:'#c0392b',sleeve:'#ffffff',cap:'#c0392b'}},\r\n"+
"  {n:5,name:'Edwardstone',jockey:'T. Cannon',trainer:'A. King',price:'5/1',pick:false,form:'2-1132',silk:{body:'#1e6b3a',sleeve:'#f0c040',cap:'#1e6b3a'}},\r\n"+
"  {n:7,name:'Chacun Pour Soi',jockey:'M.P. Walsh',trainer:'W.P. Mullins',price:'8/1',pick:false,form:'3-2213',silk:{body:'#0b1628',sleeve:'#c9a84c',cap:'#0b1628'}},\r\n"+
"  {n:2,name:'Shishkin',jockey:'J. Burke',trainer:'N. Henderson',price:'10/1',pick:false,form:'1-3224',silk:{body:'#6a2fa0',sleeve:'#ffffff',cap:'#6a2fa0'}}\r\n"+
"];\r\n\r\n"+
"var tmActiveVenue='cheltenham';\r\n"+
"var tmOpenRace={};\r\n\r\n"+
"function tmTimesHtml(m){\r\n"+
"  var selRace=tmOpenRace[m.id];\r\n"+
"  var out='<div style=\"font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#9aa3b5;padding:10px 14px 6px;border-top:1px solid #f0f2f7;margin-top:10px\">Select a race</div>';\r\n"+
"  out+='<div style=\"display:flex;gap:7px;overflow-x:auto;padding:0 14px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch\">';\r\n"+
"  m.races.forEach(function(race,ri){\r\n"+
"    var isSel=selRace===ri;\r\n"+
"    out+='<div style=\"flex-shrink:0;width:64px;border:1px solid '+(isSel?'#0b1628':'#e4e8f0')+';border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer;background:'+(isSel?'#0b1628':'#f5f7fb')+'\" onclick=\"tmSelectRace(\\''+m.id+'\\','+ri+')\">';\r\n"+
"    out+='<div style=\"font-size:13px;font-weight:700;color:'+(isSel?'#fff':'#0b1628')+'\">'+escHtml(race.t)+'</div>';\r\n"+
"    out+='<div style=\"font-size:10px;color:'+(isSel?'rgba(255,255,255,0.7)':'#9aa3b5')+';margin-top:2px\">'+race.r+' rnrs</div>';\r\n"+
"    out+='</div>';\r\n"+
"  });\r\n"+
"  out+='</div>';\r\n"+
"  return out;\r\n"+
"}\r\n\r\n"+
"function tmRaceDetailHtml(m){\r\n"+
"  var selRace=tmOpenRace[m.id];\r\n"+
"  if(selRace==null) return '';\r\n"+
"  var race=m.races[selRace];\r\n"+
"  var out='<div id=\"tm-detail-'+m.id+'\" style=\"background:#fff;border-top:1px solid #e4e8f0;border-bottom:1px solid #e4e8f0\">';\r\n"+
"  out+='<div style=\"padding:14px 16px 12px;display:flex;align-items:flex-start;justify-content:space-between\">';\r\n"+
"  out+='<div>';\r\n"+
"  out+='<div style=\"font-size:16px;font-weight:700;color:#0b1628\">'+escHtml(race.t)+' &middot; '+escHtml(m.name)+'</div>';\r\n"+
"  out+='<div style=\"font-size:11px;color:#9aa3b5;margin-top:3px\">'+escHtml(race.dist)+' &middot; '+race.r+' runners</div>';\r\n"+
"  out+='</div></div>';\r\n"+
"  TM_RUNNERS.forEach(function(r,i){\r\n"+
"    var last=i===TM_RUNNERS.length-1;\r\n"+
"    var silk=r.silk?nrSilk(r.silk):'';\r\n"+
"    var jockey=r.jockey||'';\r\n"+
"    var trainer=r.trainer?'Tr: '+r.trainer:'';\r\n"+
"    var form=r.form?nrFormHtml(r.form):'';\r\n"+
"    out+='<div style=\"display:flex;align-items:center;padding:10px 14px;border-bottom:'+(last?'none':'1px solid #f0f2f7')+';background:#fff;gap:10px\">';\r\n"+
"    out+='<div style=\"display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0\">';\r\n"+
"    out+=silk+'<span style=\"font-size:9px;color:#9aa3b5;font-weight:600\">'+r.n+'</span>';\r\n"+
"    out+='</div>';\r\n"+
"    out+='<div style=\"flex:1;min-width:0\">';\r\n"+
"    out+='<div style=\"font-size:14px;font-weight:700;color:#0b1628;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+escHtml(r.name)+'</div>';\r\n"+
"    out+='<div style=\"font-size:11px;color:#555;margin-top:2px\">'+escHtml(jockey)+'</div>';\r\n"+
"    out+=(trainer?'<div style=\"font-size:11px;color:#888;margin-top:1px\">'+escHtml(trainer)+'</div>':'');\r\n"+
"    out+=(form?'<div style=\"margin-top:3px;display:flex;align-items:center;gap:1px\">'+form+'</div>':'');\r\n"+
"    out+='</div>';\r\n"+
"    out+='<button onclick=\"nrAddToSlip(\\''+escHtml(r.name)+'\\',\\''+escHtml(r.price)+'\\')\" style=\"background:#f0f2f7;border:1px solid #e4e8f0;border-radius:8px;padding:8px 12px;cursor:pointer;font-family:inherit;text-align:center;flex-shrink:0\">';\r\n"+
"    out+='<div style=\"font-size:14px;font-weight:700;color:#0b1628\">'+escHtml(r.price)+'</div>';\r\n"+
"    out+='</button></div>';\r\n"+
"  });\r\n"+
"  out+='<div style=\"padding:12px 16px\">';\r\n"+
"  out+='<button class=\"fx-cta\" style=\"width:100%\">';\r\n"+
"  out+='<span style=\"color:var(--gold)\">&#x2756;</span> Analyse '+escHtml(race.t)+' '+escHtml(m.name)+' with AI &rarr;';\r\n"+
"  out+='</button></div></div>';\r\n"+
"  return out;\r\n"+
"}\r\n\r\n"+
"function tmSelectRace(mid,ri){\r\n"+
"  tmOpenRace[mid]=tmOpenRace[mid]===ri?null:ri;\r\n"+
"  renderInlineTomorrowMeeting();\r\n"+
"}\r\n\r\n"+
"function renderInlineTomorrowMeeting(){\r\n"+
"  var vpb=document.getElementById('tm-inline-venue-pill-bar');\r\n"+
"  var el=document.getElementById('tm-inline-meetings-list');\r\n"+
"  if(!el) return;\r\n"+
"  if(vpb){\r\n"+
"    vpb.innerHTML=TM_MEETINGS.map(function(m){\r\n"+
"      var a=tmActiveVenue===m.id;\r\n"+
"      var ts=a\r\n"+
"        ?'flex-shrink:0;padding:8px 4px;cursor:pointer;background:none;border:none;border-bottom:2px solid #1e9e6b;white-space:nowrap;font-size:13px;font-weight:700;color:#0b1628'\r\n"+
"        :'flex-shrink:0;padding:8px 4px;cursor:pointer;background:none;border:none;border-bottom:2px solid transparent;white-space:nowrap;font-size:13px;font-weight:400;color:#b0b8c8';\r\n"+
"      return '<span onclick=\"inlineTmSetVenue(\\''+m.id+'\\')\" style=\"'+ts+'\">'+escHtml(m.name)+'</span>';\r\n"+
"    }).join('');\r\n"+
"  }\r\n"+
"  var featured=TM_MEETINGS.find(function(m){return m.id===tmActiveVenue;})||TM_MEETINGS[0];\r\n"+
"  var fHtml='<div style=\"background:#fff;border-radius:12px;border:1px solid #e4e8f0;overflow:hidden;margin:0 12px 4px\">';\r\n"+
"  fHtml+='<div style=\"padding:12px 14px 10px;display:flex;align-items:baseline;gap:10px;border-bottom:1px solid #f0f2f7\">';\r\n"+
"  fHtml+='<span style=\"font-size:11px;font-weight:700;color:#9aa3b5;flex-shrink:0;width:24px\">'+escHtml(featured.flag)+'</span>';\r\n"+
"  fHtml+='<span style=\"font-size:18px;font-weight:700;color:#0b1628\">'+escHtml(featured.name)+'</span>';\r\n"+
"  fHtml+='<span style=\"font-size:12px;color:#9aa3b5;margin-left:2px\">'+featured.races.length+' races &middot; First <span style=\"color:#1e9e6b;font-weight:600\">'+escHtml(featured.races[0].t)+'</span></span>';\r\n"+
"  fHtml+='</div>';\r\n"+
"  fHtml+=rcPillsHtml(featured);\r\n"+
"  fHtml+='<div style=\"padding:12px 14px 0\">'+rcInsightsHtml(featured,false)+'</div>';\r\n"+
"  fHtml+='<button class=\"fx-cta\" style=\"margin:12px 14px 0;width:calc(100% - 28px)\"><span style=\"color:var(--gold)\">&#x2756;</span> Analyse Full '+escHtml(featured.name)+' Card with AI &rarr;</button>';\r\n"+
"  fHtml+=tmTimesHtml(featured);\r\n"+
"  fHtml+='</div>';\r\n"+
"  fHtml+=tmRaceDetailHtml(featured);\r\n"+
"  el.innerHTML=fHtml;\r\n"+
"}\r\n\r\n"+
"function inlineTmSetVenue(id){\r\n"+
"  tmActiveVenue=id;\r\n"+
"  tmOpenRace={};\r\n"+
"  renderInlineTomorrowMeeting();\r\n"+
"}\r\n\r\n"+
"function navigateToTomorrowMeeting(id){\r\n"+
"  var inline=document.getElementById('racing-tomorrow-inline-meeting');\r\n"+
"  if(!inline) return;\r\n"+
"  var isOpen=inline.style.maxHeight&&inline.style.maxHeight!=='0px';\r\n"+
"  if(isOpen&&tmActiveVenue===id){\r\n"+
"    inline.style.maxHeight='0px';\r\n"+
"    tmActiveVenue='';\r\n"+
"    return;\r\n"+
"  }\r\n"+
"  tmActiveVenue=id;\r\n"+
"  tmOpenRace={};\r\n"+
"  renderInlineTomorrowMeeting();\r\n"+
"  inline.style.maxHeight='2400px';\r\n"+
"  setTimeout(function(){inline.scrollIntoView({behavior:'smooth',block:'nearest'});},60);\r\n"+
"}\r\n";

html=html.slice(0,scriptEnd)+tmCode+html.slice(scriptEnd);
console.log('3. TM data + functions inserted');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');

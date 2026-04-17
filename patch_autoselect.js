const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

const OLD=
'function toggleTodayMeeting(id){\n'
+'  if(todayOpenMeeting===id){\n'
+'    todayOpenMeeting="";\n'
+'  } else {\n'
+'    todayOpenMeeting=id;\n'
+'    rcOpenRace={};\n'
+'  }\n'
+'  renderTodayMeetingsList();\n'
+'}';

const NEW=
'function toggleTodayMeeting(id){\n'
+'  if(todayOpenMeeting===id){\n'
+'    todayOpenMeeting="";\n'
+'    rcOpenRace={};\n'
+'  } else {\n'
+'    todayOpenMeeting=id;\n'
+'    rcOpenRace={};\n'
+'    var _m=RC_MEETINGS.filter(function(x){return x.id===id;})[0];\n'
+'    if(_m&&_m.races.length) rcOpenRace[id]=0;\n'
+'  }\n'
+'  renderTodayMeetingsList();\n'
+'}';

if(html.indexOf(OLD)<0){console.error('FAIL: toggleTodayMeeting not found');process.exit(1);}
html=html.replace(OLD,NEW);
console.log('toggleTodayMeeting: auto-selects first race on open');

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');

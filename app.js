/* MVP v1.1: Fix for iOS/Safari playback. 
 - Detect MediaRecorder MIME type (audio/mp4 for Safari, audio/webm for Chrome).
 - Guard autoplay policies (Enable Audio).
 - Better handling when decodeAudioData fails: still set audio element src to Blob.
*/
let audioCtx;
let mediaStream;
let mediaRecorder;
let audioChunks = [];
let audioBuffer = null;
let analyserNode;
let meterInterval;
let transportStarted = false;

let notes = [];
let beatsPerBar = 4;
let beatUnit = 4;
let bpm = 120;
let totalBars = 8;

const statusEl = document.getElementById('status');
const tempoEl = document.getElementById('tempo');
const timesigEl = document.getElementById('timesig');
const keyEl = document.getElementById('key');
const modeEl = document.getElementById('mode');
const audioEl = document.getElementById('audio');

function setStatus(msg){
  statusEl.textContent = msg;
  console.log("[STATUS]", msg);
}

function getTimeSig(){
  const [num, den] = timesigEl.value.split('/').map(n=>parseInt(n,10));
  beatsPerBar = num;
  beatUnit = den;
}

function getBPM(){
  bpm = Math.max(30, Math.min(240, parseInt(tempoEl.value,10)||120));
  Tone.Transport.bpm.value = bpm;
}

function barsToSeconds(bars){
  const beats = bars * beatsPerBar;
  return beats * (60 / bpm);
}

async function enableAudio(){
  if (!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended"){
    await audioCtx.resume();
  }
  await Tone.start();
  if (!transportStarted){
    Tone.Transport.start();
    Tone.Transport.pause();
    transportStarted = true;
  }
  setStatus("Audio enabled");
}

// Pick best recording type for this browser
function getPreferredMimeType(){
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2", // AAC
    "audio/mp4",
    "audio/aac"
  ];
  for (const t of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)){
      return t;
    }
  }
  return ""; // Let browser choose default
}

// Tone generator (tonic)
let toneOsc = null;
function keyToFrequency(key, mode){
  const map = {
    "C":261.63,"G":392.00,"D":293.66,"A":440.00,"E":329.63,"B":493.88,"F#":369.99,"C#":277.18,
    "F":349.23,"Bb":233.08,"Eb":311.13,"Ab":415.30,"Db":277.18,"Gb":369.99,"Cb":130.81
  };
  return map[key] || 261.63;
}
function toggleTone(){
  if (!audioCtx){ return; }
  if (toneOsc){
    toneOsc.stop(); toneOsc.disconnect(); toneOsc=null;
    setStatus("Referentietoon uit");
  }else{
    toneOsc = audioCtx.createOscillator();
    toneOsc.type = "sine";
    const gain = audioCtx.createGain(); gain.gain.value = 0.06;
    toneOsc.connect(gain).connect(audioCtx.destination);
    toneOsc.frequency.value = keyToFrequency(keyEl.value, modeEl.value);
    toneOsc.start();
    setStatus("Referentietoon aan");
  }
}

// Click track
let clickGain = new Tone.Gain(0.2).toDestination();
let clickSynth = new Tone.MembraneSynth().connect(clickGain);
function scheduleClick(startTime, totalBeats){
  const interval = 60 / bpm;
  for (let i=0;i<totalBeats;i++){
    const t = startTime + i*interval;
    const isDownbeat = (i % beatsPerBar) === 0;
    clickSynth.triggerAttackRelease(isDownbeat ? "C5":"A4", 0.02, t);
  }
}

// Recording
async function startRecordingEightBars(){
  await enableAudio();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    setStatus("Geen microfoon-toegang beschikbaar.");
    return;
  }
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){
    setStatus("Toegang geweigerd. Sta microfoon toe in je browser.");
    return;
  }
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 2048;
  source.connect(analyserNode);

  audioChunks = [];
  const opts = {};
  const mimeType = getPreferredMimeType();
  if (mimeType) opts.mimeType = mimeType;
  try{
    mediaRecorder = new MediaRecorder(mediaStream, opts);
  }catch(e){
    // Fallback without explicit mime
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = (e)=>{ if (e.data && e.data.size>0) audioChunks.push(e.data); };
  mediaRecorder.onstop = handleRecordingStop;

  startMeter();

  // Precount then record
  setStatus("Precount…");
  const now = Tone.now();
  getTimeSig(); getBPM();
  scheduleClick(now, 4);
  Tone.Transport.position = 0;

  const precountDur = 4 * (60/bpm);
  setTimeout(()=>{
    setStatus("Recording 8 bars…");
    mediaRecorder.start(); // Safari needs start() inside user flow; we're within button handler call stack chain
    // Continue click for 8 bars
    const beats = beatsPerBar * totalBars;
    scheduleClick(Tone.now(), beats);
    setTimeout(()=>{ stopRecording(); }, barsToSeconds(totalBars)*1000);
  }, precountDur*1000);
}

function stopRecording(){
  if (mediaRecorder && mediaRecorder.state !== "inactive"){
    try{ mediaRecorder.stop(); }catch{}
  }
  if (meterInterval){ clearInterval(meterInterval); meterInterval = null; }
  if (mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); }
  setStatus("Analyzing…");
}

async function handleRecordingStop(){
  // Pick a type that matches what we recorded (fallback to blob without type hint)
  let recordedType = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : "";
  let blob;
  try{
    blob = new Blob(audioChunks, recordedType ? {type: recordedType} : {});
  }catch{
    blob = new Blob(audioChunks, {});
  }
  // Set audio element src so user can play even if decode fails
  const url = URL.createObjectURL(blob);
  audioEl.src = url;

  // Try to decode for analysis (decodeAudioData doesn't support MP4 on some browsers)
  audioBuffer = null;
  try{
    const arrayBuffer = await blob.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  }catch(e){
    // If decode fails (e.g., Safari mp4 decode in AudioContext), we skip analysis
    console.warn("decodeAudioData failed:", e);
  }

  if (audioBuffer){
    setStatus("Analyseren…");
    try{
      notes = await analyzeToNotes(audioBuffer);
      renderNotation();
      setStatus("Klaar");
    }catch(e){
      console.error(e);
      setStatus("Analyse mislukt, maar audio afspelen werkt.");
    }
  }else{
    setStatus("Analyse niet mogelijk op dit formaat, maar audio afspelen werkt.");
  }
}

// Meter
function startMeter(){
  const bar = document.getElementById('bar');
  const buf = new Uint8Array(analyserNode.fftSize);
  meterInterval = setInterval(()=>{
    analyserNode.getByteTimeDomainData(buf);
    let min=255, max=0;
    for (let i=0;i<buf.length;i++){ const v=buf[i]; if(v<min)min=v; if(v>max)max=v; }
    const amp = (max-min)/255;
    bar.style.width = Math.round(amp*100) + "%";
  }, 80);
}

// Analysis (autocorrelation)
async function analyzeToNotes(buffer){
  const chan = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const frameSize = 2048;
  const hop = 256;
  const minFreq = 80;
  const maxFreq = 1000;
  const minLag = Math.floor(sr / maxFreq);
  const maxLag = Math.floor(sr / minFreq);

  function autoCorrelate(frame){
    let bestLag = -1;
    let bestCorr = 0;
    for (let lag=minLag; lag<=maxLag; lag++){
      let corr = 0;
      for (let i=0; i<frame.length-lag; i++){
        corr += frame[i]*frame[i+lag];
      }
      if (corr > bestCorr){ bestCorr = corr; bestLag = lag; }
    }
    if (bestLag<0) return 0;
    return sr / bestLag;
  }

  const f0s = [];
  for (let pos=0; pos+frameSize < chan.length; pos += hop){
    const frame = chan.slice(pos, pos+frameSize);
    for (let i=0;i<frame.length;i++){
      frame[i] *= 0.5 - 0.5*Math.cos(2*Math.PI*i/(frame.length-1));
    }
    const f0 = autoCorrelate(frame);
    f0s.push(f0);
  }

  function freqToMidi(f){
    if (!f || f<=0) return null;
    return Math.round(69 + 12*Math.log2(f/440));
  }

  const secondsPerHop = hop / sr;
  const beatsPerSecond = bpm/60;
  const minNoteSec = 0.12;
  let events = [];
  let curMidi = null;
  let curStart = 0;
  for (let i=0;i<f0s.length;i++){
    const m = freqToMidi(f0s[i]);
    if (m !== curMidi){
      const t = i*secondsPerHop;
      if (curMidi !== null){
        const dur = t - curStart;
        if (dur >= minNoteSec){
          events.push({midi: curMidi, startSec: curStart, durationSec: dur});
        }
      }
      curMidi = m;
      curStart = t;
    }
  }
  const totalSec = chan.length / sr;
  if (curMidi !== null){
    const dur = totalSec - curStart;
    if (dur >= minNoteSec){
      events.push({midi: curMidi, startSec: curStart, durationSec: dur});
    }
  }

  // Quantize to 1/8
  const grid = 0.5;
  const out = events.map(e=>{
    const startBeat = Math.round(e.startSec*beatsPerSecond/grid)*grid;
    let durBeats = Math.max(grid, Math.round(e.durationSec*beatsPerSecond/grid)*grid);
    return {midi:e.midi, startBeat, durationBeats:durBeats};
  }).sort((a,b)=>a.startBeat-b.startBeat || a.midi-b.midi);

  const merged = [];
  for (const n of out){
    const last = merged[merged.length-1];
    if (last && Math.abs(last.startBeat+last.durationBeats - n.startBeat) < 1e-3 && last.midi===n.midi){
      last.durationBeats += n.durationBeats;
    }else{
      merged.push({...n});
    }
  }
  return merged;
}

// VexFlow render
function renderNotation(){
  const container = document.getElementById('notation');
  container.innerHTML = "";
  const VF = Vex.Flow;
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  const width = Math.max(700, Math.min(1400, 40 * notes.length));
  renderer.resize(width, 180);
  const context = renderer.getContext();
  const stave = new VF.Stave(10, 30, width-20);
  stave.addClef("treble");
  try{
    const ks = keyEl.value + (modeEl.value==="minor" ? "m": "");
    stave.addKeySignature(ks);
  }catch(e){}
  stave.addTimeSignature(timesigEl.value);
  stave.setContext(context).draw();

  const tickables = [];
  function midiToNoteName(m){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const name = names[m % 12];
    const octave = Math.floor(m/12)-1;
    return name + "/" + octave;
  }
  function VF_DURATION(beats){
    if (beats < 0.75) return "8";
    if (Math.abs(beats-1) < 0.3) return "q";
    if (beats >= 2 && beats < 3.5) return "h";
    if (beats >= 4) return "w";
    return "q";
  }

  for (const n of notes){
    const keys = [midiToNoteName(n.midi)];
    const dur = VF_DURATION(n.durationBeats);
    const sn = new VF.StaveNote({clef:"treble", keys, duration: dur});
    if (keys[0].includes("#")){
      sn.addAccidental(0, new VF.Accidental("#"));
    }
    tickables.push(sn);
  }

  const voice = new VF.Voice({num_beats: beatsPerBar*totalBars,  beat_value: beatUnit});
  voice.addTickables(tickables);
  new VF.Formatter().joinVoices([voice]).format([voice], width-60);
  voice.draw(context, stave);
}

// Playback
let midiPart = null;
function stopAllPlayback(){
  try{ Tone.Transport.stop(); Tone.Transport.position = 0; }catch{}
  if (midiPart){ midiPart.stop(); midiPart.dispose(); midiPart = null; }
  if (audioEl){ audioEl.pause(); audioEl.currentTime = 0; }
}

function playMIDI(){
  stopAllPlayback();
  if (!notes.length){ setStatus("Geen noten gevonden."); return; }
  const synth = new Tone.Synth().toDestination();
  midiPart = new Tone.Part(((time, n)=>{
    const freq = Tone.Frequency(n.midi, "midi").toFrequency();
    synth.triggerAttackRelease(freq, n.durationBeats*(60/bpm), time);
  }), notes.map(n=>({time: n.startBeat*(60/bpm), ...n})));
  midiPart.start(0);
  Tone.Transport.start("+0.05");
  setStatus("Playing MIDI…");
}

function playAudio(){
  stopAllPlayback();
  if (!audioEl.src){
    setStatus("Geen audio");
    return;
  }
  const p = audioEl.play();
  if (p && p.catch){
    p.catch(()=>setStatus("Safari blokkeert autoplay: tik eerst op Enable Audio en druk dan opnieuw Play Audio."));
  }else{
    setStatus("Playing audio…");
  }
}

// Export MIDI
function exportMIDI(){
  if (!notes.length){ setStatus("Geen noten om te exporteren."); return; }
  const track = new window.MidiWriter.Track();
  track.setTempo(Math.round(bpm));
  const [num, den] = timesigEl.value.split('/').map(n=>parseInt(n));
  track.setTimeSignature(num, den);

  function midiToNameForMIDI(m){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const name = names[m % 12];
    const octave = Math.floor(m/12)-1;
    return name + octave;
  }
  function beatsToMidiDuration(quarters){
    const val = Math.max(0.125, Math.round(quarters*8)/8);
    const map = {4:"1",3:"1d",2:"2",1.5:"2d",1:"4",0.75:"4d",0.5:"8",0.375:"8d",0.25:"16",0.1875:"16d",0.125:"32"};
    let bestKey = 1; let bestDiff=1e9;
    for (const k of Object.keys(map)){
      const kv = parseFloat(k);
      const d = Math.abs(kv - val);
      if (d < bestDiff){ bestDiff = d; bestKey = kv; }
    }
    return map[bestKey];
  }

  const events = notes.map(n=>{
    const quarters = n.durationBeats * (4/beatUnit);
    return new window.MidiWriter.NoteEvent({
      pitch: [midiToNameForMIDI(n.midi)],
      duration: beatsToMidiDuration(quarters),
      wait: beatsToMidiDuration(n.startBeat*(4/beatUnit))
    });
  });
  track.addEvent(events, e=>({sequential:true}));
  const write = new window.MidiWriter.Writer([track]);
  const blob = new Blob([write.buildFile()], {type: "audio/midi"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = "melody.mid"; a.click();
}

// Lyrics
function syllabify(text){
  return text.trim().split(/\s+|-/).filter(Boolean);
}
function fitLyrics(){
  const text = document.getElementById('lyrics').value;
  if (!text){ setStatus("Geen lyrics ingevoerd."); return; }
  if (!notes.length){ setStatus("Geen noten om lyrics op te plaatsen."); return; }
  const syl = syllabify(text);
  let assigned = [];
  let i=0;
  for (let n=0;n<notes.length;n++){
    let s = syl[i] || "_";
    assigned.push(s);
    if (i < syl.length-1) i++;
  }
  const svg = document.querySelector("#notation svg");
  if (!svg){ setStatus("Notatie niet gevonden."); return; }
  svg.querySelectorAll(".lyric").forEach(el=>el.remove());
  const noteheads = svg.querySelectorAll("g.vf-stavenote");
  noteheads.forEach((g, idx)=>{
    const bbox = g.getBBox();
    const t = document.createElementNS("http://www.w3.org/2000/svg","text");
    t.setAttribute("class","lyric");
    t.setAttribute("x", bbox.x + bbox.width/2);
    t.setAttribute("y", bbox.y + bbox.height + 18);
    t.setAttribute("text-anchor","middle");
    t.setAttribute("font-size","12");
    t.setAttribute("fill","#a7f3d0");
    t.textContent = assigned[idx] || "_";
    svg.appendChild(t);
  });
  setStatus("Lyrics geplaatst.");
}

// Test scale
function generateScale(){
  const base = 60; // C4
  const pattern = [0,2,4,5,7,9,11,12];
  notes = pattern.map((p, i)=>({midi: base+p, startBeat: i*1, durationBeats: 1}));
  renderNotation();
  setStatus("Testtoonladder gegenereerd.");
}

// Events
document.getElementById('enable').addEventListener('click', enableAudio);
document.getElementById('tone').addEventListener('click', toggleTone);
document.getElementById('precount').addEventListener('click', ()=>{ getTimeSig(); getBPM(); scheduleClick(Tone.now(), 4); setStatus("Precount 4 (los)"); });
document.getElementById('record').addEventListener('click', startRecordingEightBars);
document.getElementById('stop').addEventListener('click', stopRecording);
document.getElementById('play-audio').addEventListener('click', playAudio);
document.getElementById('play-midi').addEventListener('click', playMIDI);
document.getElementById('export-midi').addEventListener('click', exportMIDI);
document.getElementById('fit-lyrics').addEventListener('click', fitLyrics);
document.getElementById('gen-scale').addEventListener('click', generateScale);

tempoEl.addEventListener('change', getBPM);
timesigEl.addEventListener('change', getTimeSig);
keyEl.addEventListener('change', ()=>{ if (toneOsc) toneOsc.frequency.value = keyToFrequency(keyEl.value, modeEl.value); });
modeEl.addEventListener('change', ()=>{ if (toneOsc) toneOsc.frequency.value = keyToFrequency(keyEl.value, modeEl.value); });

getTimeSig(); getBPM();

// Metronome volume control
const metVolEl = document.getElementById('metVol');
const metVolLbl = document.getElementById('metVolLbl');
function setMetronomeVolumeFromUI(){
  const v = Math.max(0, Math.min(100, parseInt(metVolEl.value||"20",10)));
  metVolLbl.textContent = v + "%";
  const linear = v/100;
  if (typeof Tone !== "undefined" && clickGain){
    clickGain.gain.rampTo(linear, 0.01);
  }
}
if (metVolEl){ metVolEl.addEventListener('input', setMetronomeVolumeFromUI); }
setMetronomeVolumeFromUI();

setStatus("Idle");

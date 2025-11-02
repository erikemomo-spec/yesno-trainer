import React, { useEffect, useMemo, useRef, useState } from "react";

// ====== Utilities ======
const defaultItems = [
  { id: 1, topic: "Daily Life", question: "Do you like coffee?", yesSample: "Yes, I do.", noSample: "No, I don't." },
  { id: 2, topic: "General Knowledge", question: "Is Tokyo the capital of Japan?", yesSample: "Yes, it is.", noSample: "No, it isn't." },
  { id: 3, topic: "Study", question: "Did you study English yesterday?", yesSample: "Yes, I did.", noSample: "No, I didn't." },
  { id: 4, topic: "Plans", question: "Will you go out this weekend?", yesSample: "Yes, I will.", noSample: "No, I won't." },
  { id: 5, topic: "Abilities", question: "Can you swim?", yesSample: "Yes, I can.", noSample: "No, I can't." },
];

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem("yn_trainer_items_v1");
    if (!raw) return defaultItems;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultItems;
    return parsed;
  } catch (e) {
    return defaultItems;
  }
}
function saveToLocalStorage(items) {
  try { localStorage.setItem("yn_trainer_items_v1", JSON.stringify(items)); } catch {}
}

function speak(text, voice, rate = 1, pitch = 1, onend) {
  try {
    const utter = new SpeechSynthesisUtterance(text);
    if (voice) utter.voice = voice;
    utter.rate = rate; utter.pitch = pitch;
    if (onend) {
      utter.onend = () => { try { onend(); } catch {} };
      utter.onerror = () => { try { onend(); } catch {} };
    }
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
    return utter;
  } catch (e) { console.warn(e); }
}

function useVoices() {
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices?.() || []);
    load();
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", load);
  }, []);
  return voices;
}
function pickEnglishVoices(voices) {
  return voices.filter(v => /en[-_]/i.test(v.lang) || /English/i.test(v.name));
}

// Map ASR transcript to yes/no
function parseYesNo(transcript) {
  if (!transcript) return null;
  const t = transcript.toLowerCase().trim();
  const yesWords = [
    "yes","yeah","yep","yup","sure","of course","i do","i did","i am","i will","i can","it is"
  ];
  const noWords  = [
    "no","nope","nah","not","i don't","i did not","i didn't","i am not","i won't","i will not","i can't","cannot","it isn't","it is not"
  ];
  if (yesWords.some(w => t.startsWith(w) || t.includes(` ${w} `) || t === w)) return "yes";
  if (noWords.some(w  => t.startsWith(w) || t.includes(` ${w} `) || t === w)) return "no";
  return null;
}

// ====== Main Component ======
export default function YesNoSpeakingTrainer() {
  // --- Core states ---
  const [items, setItems] = useState(loadFromLocalStorage());
  const [currentIndex, setCurrentIndex] = useState(0);
  const [listening, setListening] = useState(false);
  const [recognized, setRecognized] = useState(""); // latest chunk
  const [random, setRandom] = useState(true);
  const [useTTS, setUseTTS] = useState(true);
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [targetLang, setTargetLang] = useState("en-US");

  // 両方の回答を要求
  const [needed, setNeeded] = useState({ yes: true, no: true });
  const [practiceSec, setPracticeSec] = useState(8); // 一問あたりの練習時間（秒）
  const [phase, setPhase] = useState('idle'); // 'idle' | 'practice' | 'reveal'

  // Device & permission states — 定義は最初に
  const [devices, setDevices] = useState([]); // audioinput devices
  const [selectedMicId, setSelectedMicId] = useState("");
  const [permission, setPermission] = useState(null); // null | 'granted' | 'denied' | 'prompt'
  const [audioLevel, setAudioLevel] = useState(0); // 0..1
  const mediaStreamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const autoAdvanceRef = useRef(false); // 次問題への自動開始フラグ

  // Topic filtering & 10-question session
  const topics = useMemo(() => Array.from(new Set(items.map(it => it.topic || "Untitled"))), [items]);
  const [selectedTopic, setSelectedTopic] = useState("All");
  const [sessionSet, setSessionSet] = useState(null); // null | number[] (ids)
  const [sessionCursor, setSessionCursor] = useState(0); // 0..len-1
  const viewItems = useMemo(() => {
    const pool = (selectedTopic === "All") ? items : items.filter(it => (it.topic || "Untitled") === selectedTopic);
    return sessionSet ? pool.filter(it => sessionSet.includes(it.id)) : pool;
  }, [items, selectedTopic, sessionSet]);

  // セッション中は ID 基準で現在を特定
  const current = useMemo(() => {
    if (sessionSet && sessionSet.length) {
      const id = sessionSet[sessionCursor] ?? sessionSet[0];
      return items.find(it => it.id === id) || viewItems[0] || items[0];
    }
    return viewItems[currentIndex] || viewItems[0] || items[0];
  }, [items, viewItems, sessionSet, sessionCursor, currentIndex]);

  // Persist items
  useEffect(() => { saveToLocalStorage(items); }, [items]);
  // Re-acquire stream when mic changes
  useEffect(() => { if (selectedMicId) { ensureStream().catch(()=>{}); } }, [selectedMicId]);

  // Speech Synthesis voices
  const voices = useVoices();
  const engVoices = useMemo(() => pickEnglishVoices(voices), [voices]);
  const [voiceName, setVoiceName] = useState("");
  useEffect(() => { if (engVoices.length && !voiceName) setVoiceName(engVoices[0].name); }, [engVoices, voiceName]);
  const selectedVoice = useMemo(() => engVoices.find(v => v.name === voiceName), [engVoices, voiceName]);

  // Speech Recognition setup
  const recRef = useRef(null);
  const recAvailable = typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  const practiceTimerRef = useRef(null);

  useEffect(() => {
    if (!recAvailable) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = targetLang;
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (e) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        txt += e.results[i][0].transcript;
      }
      setRecognized(txt);

      if (e.results[e.results.length - 1].isFinal) {
        const yn = parseYesNo(txt);
        if (yn === 'yes' || yn === 'no') {
          setNeeded(prev => {
            const next = { ...prev, [yn]: false };
            if (!next.yes && !next.no) {
              fastReveal(); // 両方言えたら即リビール
            }
            return next;
          });
        }
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);

    recRef.current = rec;
    return () => { try { rec.stop(); } catch {} };
  }, [recAvailable, targetLang]);

  // Permissions & device list
  useEffect(() => {
    try {
      navigator.permissions?.query?.({ name: 'microphone' }).then(p => {
        setPermission(p.state);
        p.onchange = () => setPermission(p.state);
      }).catch(()=>{});
    } catch {}
  }, []);

  async function ensureStream(withPrompt = false) {
    const constraints = { audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      attachStream(stream);
      await refreshDevices();
      return stream;
    } catch (e) {
      console.warn('getUserMedia error', e);
      if (withPrompt) alert('マイクにアクセスできませんでした。ブラウザの権限やWindowsの設定をご確認ください。');
      throw e;
    }
  }

  function attachStream(stream) {
    if (mediaStreamRef.current) stopStream();
    mediaStreamRef.current = stream;
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024; analyserRef.current = analyser; source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0; for (let i=0;i<data.length;i++){ const v = (data[i]-128)/128; sum += v*v; }
        const rms = Math.sqrt(sum / data.length);
        setAudioLevel(rms);
        rafRef.current = requestAnimationFrame(loop);
      };
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) { console.warn('Audio meter init failed', e); }
  }

  function stopStream() {
    try { cancelAnimationFrame(rafRef.current); } catch {}
    try { mediaStreamRef.current?.getTracks?.().forEach(t=>t.stop()); } catch {}
    try { audioCtxRef.current?.close?.(); } catch {}
    mediaStreamRef.current = null; analyserRef.current = null; audioCtxRef.current = null;
  }

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter(d => d.kind === 'audioinput');
      setDevices(mics);
      if (!selectedMicId && mics[0]) setSelectedMicId(mics[0].deviceId);
    } catch (e) { console.warn('enumerateDevices failed', e); }
  }

  // Start once to get permissions
  useEffect(() => { if (navigator.mediaDevices?.getUserMedia) { ensureStream().catch(()=>{}); } }, []);
  // セッションカーソル or インデックスが変わった直後に最新の current で ask()
  useEffect(() => {
    if (autoAdvanceRef.current) {
      autoAdvanceRef.current = false;
      setTimeout(() => ask(), 0);
    }
  }, [sessionCursor, currentIndex]);
  useEffect(() => { return () => stopStream(); }, []);

  // === Session helpers ===
  function buildSession(count = 10) {
    const pool = (selectedTopic === "All") ? items : items.filter(it => (it.topic || "Untitled") === selectedTopic);
    const unique = Array.from(new Set(pool.map(it => it.id)));
    const shuffled = unique.sort(() => Math.random() - 0.5);
    const ids = shuffled.slice(0, Math.min(count, shuffled.length));
    setSessionSet(ids);
    setSessionCursor(0);
    resetNeeded();
    autoAdvanceRef.current = true; // セッション開始時に自動で ask() する
  }

  // レガシー互換（古い呼び出しが残ってもOK）
  function advanceInSession() { goNext(); }

  // === Practice flow ===
  function startRecognition() {
    try { recRef.current?.stop?.(); } catch {}
    try { recRef.current?.start?.(); setListening(true); } catch (e) { console.warn('recognition start failed', e); setListening(false); }
  }

  function resetNeeded() { setNeeded({ yes: true, no: true }); setRecognized(""); }

  function ask() {
    resetNeeded();
    setPhase('practice');
    const q = current?.question || '';
    if (useTTS) {
      speak(q, selectedVoice, rate, pitch, () => {
        setTimeout(() => startRecognition(), 200);
        clearTimeout(practiceTimerRef.current);
        practiceTimerRef.current = setTimeout(() => reveal(), practiceSec * 1000);
      });
    } else {
      startRecognition();
      clearTimeout(practiceTimerRef.current);
      practiceTimerRef.current = setTimeout(() => reveal(), practiceSec * 1000);
    }
  }

  function fastReveal() {
    if (phase !== 'practice') return;
    clearTimeout(practiceTimerRef.current);
    reveal();
  }

  function goNext() {
    // セッションあり：カーソルを進める
    if (sessionSet && sessionSet.length) {
      const next = sessionCursor + 1;
      if (next < sessionSet.length) {
        setSessionCursor(next);
        resetNeeded();
        autoAdvanceRef.current = true; // 次レンダ後に ask()
      } else {
        setPhase('idle');
        setSessionSet(null);
        alert('セッション終了です。おつかれさま！');
      }
      return;
    }
    // セッションなし：通常モードで前進
    if (!viewItems.length) return;
    if (random) {
      const currentId = current?.id ?? null;
      let idx = Math.floor(Math.random() * viewItems.length);
      if (viewItems.length > 1) {
        let guard = 0;
        while (viewItems[idx]?.id === currentId && guard < 10) {
          idx = Math.floor(Math.random() * viewItems.length);
          guard++;
        }
      }
      setCurrentIndex(idx);
    } else {
      setCurrentIndex(i => (i + 1) % viewItems.length);
    }
    resetNeeded();
    autoAdvanceRef.current = true; // 次レンダ後に ask()
  }

  function reveal() {
    setPhase('reveal');
    try { recRef.current?.stop?.(); } catch {}
    const ansText = `Answer: ${current?.yesSample || ''} / ${current?.noSample || ''}`;
    if (useTTS) {
      speak(ansText, selectedVoice, rate, pitch, () => {
        goNext();
      });
    } else {
      goNext();
    }
  }

  // === Editing utilities ===
  function addNewItem() {
    const maxId = items.reduce((m, it) => Math.max(m, it.id || 0), 0);
    const topic = selectedTopic === 'All' ? 'Untitled' : selectedTopic;
    const newItem = { id: maxId + 1, topic, question: 'New question?', yesSample: 'Yes.', noSample: 'No.' };
    setItems(prev => [...prev, newItem]);
  }
  function exportItems() {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'yesno-items.json'; a.click();
    URL.revokeObjectURL(url);
  }

  // ===== Dev self-tests for parseYesNo =====
  useEffect(() => {
    const cases = [
      ["Yes", "yes"],
      ["No", "no"],
      ["Yeah, I think so", "yes"],
      ["Nope, I don't", "no"],
      ["I don't know", "no"],
      ["Absolutely yes", "yes"],
      ["Not really", "no"],
      ["Maybe", null],
      ["Yes, I can.", "yes"],
      ["I will not.", "no"],
      ["It is.", "yes"],
      ["It isn't.", "no"],
      // 追加テスト（既存に影響しない）
      ["Sure.", "yes"],
      ["No, thanks.", "no"],
    ];
    cases.forEach(([input, expected]) => {
      const got = parseYesNo(input);
      console.assert(got === expected, `parseYesNo('${input}') => ${got}, expected ${expected}`);
    });
  }, []);

  // === UI ===
  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-6">
        {/* 左：練習パネル */}
        <div className="bg-white rounded-2xl shadow p-5">
          <h1 className="text-xl font-bold mb-3">Yes/No スピーキング練習（シンプル）</h1>

          {/* テーマ & セッション */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-600">テーマ:</span>
              <select className="px-2 py-1 rounded-lg border" value={selectedTopic} onChange={e=>{ setSelectedTopic(e.target.value); setSessionSet(null); setSessionCursor(0); setCurrentIndex(0); }}>
                <option value="All">All</option>
                {topics.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {!sessionSet ? (
              <button className="px-3 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700" onClick={()=>{ buildSession(10); }}>
                このテーマで10問セッション開始
              </button>
            ) : (
              <span className="text-sm px-2 py-1 rounded bg-slate-100">進行: {sessionCursor+1} / {sessionSet.length}</span>
            )}
          </div>

          {/* 現在の問題 */}
          <div className="border rounded-xl p-4 mb-4">
            <div className="text-slate-500 text-xs mb-1">Question</div>
            <div className="text-lg font-semibold">{current?.question || "No question"}</div>
            <div className="mt-2 text-sm text-slate-600">
              <span className="mr-3">Yes 例: <span className="font-mono">{current?.yesSample}</span></span>
              <span>No 例: <span className="font-mono">{current?.noSample}</span></span>
            </div>
          </div>

          {/* 操作 */}
          <div className="flex flex-wrap items-center gap-2">
            <button className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700" onClick={ask} disabled={!current}>
              質問を読む → 練習開始
            </button>
            <label className="flex items-center gap-2 text-sm">
              練習時間（秒）
              <input type="number" className="w-20 px-2 py-1 border rounded-lg" min={3} max={20} value={practiceSec} onChange={e=>setPracticeSec(Math.max(3, Math.min(20, Number(e.target.value)||8)))} />
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useTTS} onChange={e=>setUseTTS(e.target.checked)} />音声読み上げ</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={random} onChange={e=>setRandom(e.target.checked)} />ランダム</label>
            <span className="text-xs text-slate-500">状態: {phase}</span>
          </div>

          {/* 音声設定（速度・ピッチ・声質） */}
          <div className="mt-4 border rounded-xl p-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
              <label className="text-sm flex flex-col gap-1">
                <span>Voice</span>
                <select
                  className="px-2 py-2 rounded-lg border w-full"
                  value={voiceName}
                  onChange={e=>setVoiceName(e.target.value)}
                >
                  {engVoices.length ? engVoices.map(v => (
                    <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                  )) : <option value="">Default</option>}
                </select>
              </label>

              <label className="text-sm flex flex-col gap-1 w-full">
                <span>Speed: <span className="font-mono align-middle">{rate.toFixed(2)}x</span></span>
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.05}
                  value={rate}
                  onChange={e=>setRate(Number(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="text-sm flex flex-col gap-1 w-full">
                <span>Pitch: <span className="font-mono align-middle">{pitch.toFixed(2)}</span></span>
                <input
                  type="range"
                  min={0.8}
                  max={1.4}
                  step={0.05}
                  value={pitch}
                  onChange={e=>setPitch(Number(e.target.value))}
                  className="w-full"
                />
              </label>
            </div>
            <div className="mt-4">
              <button
                className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 w-full md:w-auto"
                onClick={()=>speak(current?.question||'', selectedVoice, rate, pitch)}
              >
                🔊 テスト再生（現在の設定）
              </button>
            </div>
          </div>

          {/* マイク選択 & 入力レベル */}
          <div className="mt-4 border rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">マイク:</span>
                <select className="px-2 py-1 rounded-lg border" value={selectedMicId} onChange={e=>setSelectedMicId(e.target.value)}>
                  {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
                </select>
                <button className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200" onClick={()=>refreshDevices()}>再読み込み</button>
              </div>
            </div>
            <div className="mt-3 text-sm text-slate-600">入力レベル</div>
            <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Math.round(audioLevel*100))}%` }} />
            </div>
          </div>
        </div>

        {/* 右：スクリプト一覧（編集可能・広いテキストエリア） */}
        <div className="bg-white rounded-2xl shadow p-5 overflow-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">スクリプト一覧</h2>
            <div className="flex gap-2">
              <button className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200" onClick={addNewItem}>新規追加</button>
              <button className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200" onClick={exportItems}>エクスポート</button>
              <ImportButton onImport={(text)=>{ try{ const arr = JSON.parse(text); if(Array.isArray(arr)) setItems(arr); else alert('JSON配列ではありません'); } catch(e){ alert('JSON読み込みに失敗しました'); } }} />
            </div>
          </div>

          <div className="space-y-4">
            {items.slice().reverse().map((it) => (
              <div key={it.id} className={`border rounded-xl p-3 ${current && it.id===current.id ? 'bg-amber-50' : ''}`}>
                <div className="flex flex-wrap gap-3 items-center mb-2">
                  <span className="text-xs px-2 py-1 rounded bg-slate-100">ID: {it.id}</span>
                  <label className="text-sm flex items-center gap-2">Topic
                    <input className="px-2 py-1 border rounded w-56" value={it.topic || ''} onChange={e=>setItems(prev=>prev.map(p=>p.id===it.id?{...p, topic:e.target.value}:p))} />
                  </label>
                  <button className="ml-auto text-rose-600 hover:underline" onClick={()=>{ if(confirm('削除しますか？')) setItems(prev=>prev.filter(p=>p.id!==it.id)); }}>削除</button>
                </div>
                <label className="block text-sm mb-2">Question
                  <textarea rows={4} className="mt-1 w-full px-3 py-2 border rounded-lg" value={it.question || ''} onChange={e=>setItems(prev=>prev.map(p=>p.id===it.id?{...p, question:e.target.value}:p))} />
                </label>
                <div className="grid md:grid-cols-2 gap-3">
                  <label className="text-sm">Yes Sample
                    <textarea rows={3} className="mt-1 w-full px-3 py-2 border rounded-lg" value={it.yesSample || ''} onChange={e=>setItems(prev=>prev.map(p=>p.id===it.id?{...p, yesSample:e.target.value}:p))} />
                  </label>
                  <label className="text-sm">No Sample
                    <textarea rows={2} className="mt-1 w-full px-3 py-2 border rounded-lg" value={it.noSample || ''} onChange={e=>setItems(prev=>prev.map(p=>p.id===it.id?{...p, noSample:e.target.value}:p))} />
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ====== ImportButton ======
function ImportButton({ onImport }) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => onImport?.(String(reader.result || ""));
          reader.readAsText(file);
        }}
      />
      <button className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200" onClick={() => inputRef.current?.click()}>
        インポート
      </button>
    </>
  );
}

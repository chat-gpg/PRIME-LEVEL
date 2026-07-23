import React, { useState, useEffect, useMemo, useRef } from "react";
import { 
  Plus, X, Zap, Dumbbell, Activity, LayoutGrid, Trash2, 
  Clock, Gauge, HeartPulse, ChevronRight, Upload, Settings, 
  TrendingUp, Lock, User, LogOut, LogIn 
} from "lucide-react";
import { auth, db } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged 
} from "firebase/auth";
import { 
  collection, 
  doc, 
  setDoc, 
  onSnapshot 
} from "firebase/firestore";
// ============================================================================
// PARTIE 1 : CONFIGURATION ET CONSTANTES GLOBALES
// ============================================================================

const TYPES = {
  course: { label: "Course", color: "#FF5A3C" },
  force: { label: "Force", color: "#3DDC97" },
  hyrox: { label: "Hyrox", color: "#FFC53D" },
};

const RANK_NAMES = ["Bronze", "Argent", "Or", "Platine", "Diamant"];
const RANK_COLORS = ["#C97A3D", "#B9C2D4", "#FFD54A", "#4FE3D6", "#9C8CFF"];

// Générateur d'ID unique pour les séances
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Helper pour associer l'icône Lucide correspondante de manière sécurisée
function getDisciplineIcon(type) {
  switch (type) {
    case "course": return Activity;
    case "force": return Dumbbell;
    case "hyrox": return Zap;
    default: return Activity;
  }
}

// ============================================================================
// PARTIE 2 : FONCTIONS MATHEMATIQUES ET PARSER GPX
// ============================================================================

// Calcul de la distance entre deux points GPS (Formule d'Haversine)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Extraction des données d'un fichier GPX (Strava, Garmin, etc.)
function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Fichier GPX invalide.");
  const points = Array.from(doc.getElementsByTagName("trkpt"));
  if (points.length === 0) throw new Error("Aucune trace trouvée dans ce fichier.");

  let distanceM = 0, prev = null, hrSum = 0, hrCount = 0;
  const times = [];
  for (const pt of points) {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    if (prev) distanceM += haversine(prev.lat, prev.lon, lat, lon);
    prev = { lat, lon };
    const timeEl = pt.getElementsByTagName("time")[0];
    if (timeEl) times.push(new Date(timeEl.textContent).getTime());
    const hrEl = pt.getElementsByTagName("hr")[0] || pt.getElementsByTagName("ns3:hr")[0];
    if (hrEl) {
      const v = parseFloat(hrEl.textContent);
      if (!isNaN(v)) { hrSum += v; hrCount += 1; }
    }
  }
  const durationMin = times.length >= 2 ? Math.round((times[times.length - 1] - times[0]) / 60000) : "";
  const dateStr = times.length ? new Date(times[0]).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return {
    date: dateStr,
    distance: (distanceM / 1000).toFixed(2),
    duree: durationMin || "",
    fc: hrCount ? Math.round(hrSum / hrCount) : "",
  };
}

// ============================================================================
// PARTIE 3 : MOTEUR DE RANKING (CALCUL DES RANGS ET TIER)
// ============================================================================

function interpScore(value, points) {
  const n = points.length;
  const increasing = points[n - 1][0] > points[0][0];
  if (increasing) {
    if (value <= points[0][0]) return points[0][1];
    if (value >= points[n - 1][0]) return points[n - 1][1];
  } else {
    if (value >= points[0][0]) return points[0][1];
    if (value <= points[n - 1][0]) return points[n - 1][1];
  }
  for (let i = 0; i < n - 1; i++) {
    const [v1, s1] = points[i], [v2, s2] = points[i + 1];
    const between = increasing ? value >= v1 && value <= v2 : value <= v1 && value >= v2;
    if (between) {
      const t = (value - v1) / (v2 - v1);
      return s1 + t * (s2 - s1);
    }
  }
  return points[n - 1][1];
}

const COURSE_PTS = [[8.0, 0], [6.5, 1], [5.5, 2], [4.75, 3], [4.0, 4], [3.5, 5]]; // min/km
const SQUAT_PTS = [[0.5, 0], [0.75, 1], [1.25, 2], [1.5, 3], [2.0, 4], [2.5, 5]]; // x poids corps
const DEADLIFT_PTS = [[0.75, 0], [1.0, 1], [1.5, 2], [2.0, 3], [2.5, 4], [3.0, 5]];
const BENCH_PTS = [[0.35, 0], [0.5, 1], [0.75, 2], [1.0, 3], [1.5, 4], [1.75, 5]];
const HYROX_PTS = [[130, 0], [105, 1], [90, 2], [75, 3], [60, 4], [50, 5]]; // minutes total

function tierFromScore(score) {
  const idx = Math.max(0, Math.min(4, Math.floor(score)));
  const frac = Math.max(0, Math.min(1, score - idx));
  return { idx, frac, name: RANK_NAMES[idx], color: RANK_COLORS[idx], score };
}

function percentileFromScore(score) {
  const pct = Math.round((score / 5) * 100);
  return Math.max(1, Math.min(99, pct));
}

function computeRanks(sessions, profile) {
  const courseSessions = sessions.filter((s) => s.type === "course" && parseFloat(s.distance) > 0 && parseFloat(s.duree) > 0);
  let courseScore = null;
  if (courseSessions.length) {
    const bestPace = Math.min(...courseSessions.map((s) => parseFloat(s.duree) / parseFloat(s.distance)));
    courseScore = interpScore(bestPace, COURSE_PTS);
  }

  let forceScore = null;
  if (profile.poids > 0) {
    const parts = [];
    if (profile.squat > 0) parts.push(interpScore(profile.squat / profile.poids, SQUAT_PTS));
    if (profile.deadlift > 0) parts.push(interpScore(profile.deadlift / profile.poids, DEADLIFT_PTS));
    if (profile.bench > 0) parts.push(interpScore(profile.bench / profile.poids, BENCH_PTS));
    if (parts.length) forceScore = parts.reduce((a, b) => a + b, 0) / parts.length;
  }

  const hyroxSessions = sessions.filter((s) => s.type === "hyrox" && parseFloat(s.duree) > 0);
  let hyroxScore = null;
  if (hyroxSessions.length) {
    const bestTime = Math.min(...hyroxSessions.map((s) => parseFloat(s.duree)));
    hyroxScore = interpScore(bestTime, HYROX_PTS);
  }

  const available = [courseScore, forceScore, hyroxScore].filter((s) => s !== null);
  const overallScore = available.length ? available.reduce((a, b) => a + b, 0) / available.length : null;

  return {
    course: courseScore !== null ? tierFromScore(courseScore) : null,
    force: forceScore !== null ? tierFromScore(forceScore) : null,
    hyrox: hyroxScore !== null ? tierFromScore(hyroxScore) : null,
    overall: overallScore !== null ? tierFromScore(overallScore) : null,
  };
}

// ============================================================================
// PARTIE 4 : COMPOSANTS D'INTERFACE REUTILISABLES (BADGES, GAUGES)
// ============================================================================

function Hexagon({ color = "#9C8CFF", size = 64, glow = true, locked = false }) {
  const pts = "50,3 93,26 93,74 50,97 7,74 7,26";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <defs>
        <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="100%" stopColor={color} stopOpacity="0.5" />
        </linearGradient>
        <filter id={`glow-${color.replace("#", "")}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <polygon
        points={pts}
        fill={locked ? "#1B202C" : `url(#grad-${color.replace("#", "")})`}
        stroke={locked ? "#333949" : color}
        strokeWidth="3"
        filter={glow && !locked ? `url(#glow-${color.replace("#", "")})` : undefined}
      />
    </svg>
  );
}

function RankBadge({ rank, size = 64, showLabel = true }) {
  if (!rank) {
    return (
      <div className="flex flex-col items-center gap-1">
        <div style={{ width: size, height: size, position: "relative" }} className="flex items-center justify-center">
          <Hexagon color="#3A404F" size={size} locked glow={false} />
          <Lock size={size * 0.28} style={{ position: "absolute" }} color="#5A6072" />
        </div>
        {showLabel && <span className="text-[10px] font-mono text-[#5A6072]">Non classé</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <div style={{ position: "relative", width: size, height: size }}>
        <Hexagon color={rank.color} size={size} />
      </div>
      {showLabel && (
        <span className="text-[11px] font-display font-bold uppercase tracking-wide" style={{ color: rank.color }}>
          {rank.name}
        </span>
      )}
    </div>
  );
}

function XPBar({ rank, color }) {
  const pct = rank ? Math.round(rank.frac * 100) : 0;
  return (
    <div className="w-full h-2 rounded-full bg-[#1B202C] overflow-hidden border border-[#262C3A]">
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${rank ? pct : 0}%`, background: `linear-gradient(90deg, ${color}66, ${color})`, boxShadow: `0 0 8px ${color}99` }}
      />
    </div>
  );
}

function ComparisonGauge({ score, color }) {
  const pct = score !== null ? Math.max(0, Math.min(100, (score / 5) * 100)) : 0;
  return (
    <div className="w-full">
      <div className="relative w-full h-3 rounded-full overflow-hidden flex border border-[#262C3A]">
        {RANK_COLORS.map((c, i) => (
          <div key={i} style={{ flex: 1, background: `${c}33` }} />
        ))}
        {score !== null && (
          <div
            className="absolute top-1/2 w-3.5 h-3.5 rounded-full border-2 border-[#090B11]"
            style={{ left: `calc(${pct}% - 7px)`, transform: "translateY(-50%)", background: color, boxShadow: `0 0 8px ${color}` }}
          />
        )}
      </div>
      <div className="flex justify-between mt-1">
        {RANK_NAMES.map((n) => (
          <span key={n} className="text-[8px] font-mono text-[#454B5C] flex-1 text-center first:text-left last:text-right">{n}</span>
        ))}
      </div>
    </div>
  );
}

function DisciplineDetail({ discKey, rank }) {
  const t = TYPES[discKey];
  const pct = rank ? percentileFromScore(rank.score) : null;
  const explain = {
    course: "Basé sur ta meilleure allure enregistrée (min/km).",
    force: "Basé sur le ratio charge / poids de corps (squat, soulevé de terre, développé couché).",
    hyrox: "Basé sur ton meilleur temps total de circuit loggé.",
  }[discKey];

  return (
    <div className="rounded-2xl bg-[#131722] border border-[#1F2530] p-4 mb-4">
      <div className="flex items-center gap-4 mb-3">
        <RankBadge rank={rank} size={56} showLabel={false} />
        <div>
          <div className="font-orbitron text-lg font-bold" style={{ color: rank ? rank.color : "#5A6072" }}>
            {rank ? rank.name.toUpperCase() : "NON CLASSÉ"}
          </div>
          {rank && (
            <div className="text-xs font-mono" style={{ color: t.color }}>
              Meilleur que ~{pct}% des pratiquants
            </div>
          )}
        </div>
      </div>
      <ComparisonGauge score={rank ? rank.score : null} color={rank ? rank.color : "#5A6072"} />
      <p className="text-[10px] text-[#5A6072] font-mono mt-3 leading-relaxed">{explain}</p>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs text-[#7B8298] block mb-1">{label}</label>
      {children}
    </div>
  );
}

function NavBtn({ active, onClick, icon: Icon, label, color }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-0.5 flex-1 py-1">
      <Icon size={20} color={active ? color : "#454B5C"} />
      <span className="text-[10px]" style={{ color: active ? "#EAEDF5" : "#454B5C" }}>{label}</span>
    </button>
  );
}

function SessionList({ items, onDelete, onEdit }) {
  if (items.length === 0) {
    return <div className="text-sm text-[#454B5C] py-10 text-center font-mono">Aucune séance pour l'instant.</div>;
  }

  return (
    <div className="space-y-2">
      {items.map((s) => {
        const t = TYPES[s.type] || TYPES.course;
        const IconComponent = getDisciplineIcon(s.type);

        return (
          <div key={s.id} className="rounded-xl bg-[#131722] border border-[#1F2530] p-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: t.color + "22" }}>
              <IconComponent size={16} color={t.color} />
            </div>
            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onEdit(s)}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{t.label}</span>
                <span className="text-xs text-[#5A6072] font-mono">
                  {new Date(s.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-[#8A91A8] font-mono flex-wrap">
                {s.distance && <span className="flex items-center gap-1"><Gauge size={11} />{s.distance} km</span>}
                {s.duree && <span className="flex items-center gap-1"><Clock size={11} />{s.duree} min</span>}
                {s.fc && <span className="flex items-center gap-1"><HeartPulse size={11} />{s.fc} bpm</span>}
              </div>
              {s.details && <div className="text-xs text-[#5A6072] mt-1 line-clamp-2">{s.details}</div>}
            </div>
            <button onClick={() => onDelete(s.id)} className="text-[#454B5C] p-1 shrink-0">
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Formulaire vide par défaut
const emptyForm = (type) => ({
  id: null, type, date: new Date().toISOString().slice(0, 10),
  distance: "", duree: "", fc: "", ressenti: "3", details: "",
});

// ============================================================================
/// ============================================================================
// PARTIE 5 : COMPOSANT PRINCIPAL (APP)
// ============================================================================

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [profile, setProfile] = useState({ poids: "", squat: "", deadlift: "", bench: "" });
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("overview");
  const [formOpen, setFormOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [form, setForm] = useState(emptyForm("course"));
  const [error, setError] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const fileInputRef = useRef(null);
  const [user, setUser] = useState(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // --- FONCTIONS DE CONNEXION / DÉCONNEXION À AJOUTER ICI ---
  const handleGoogleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
      setUserMenuOpen(false);
    } catch (err) {
      setError("Erreur lors de la connexion Google");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setUserMenuOpen(false);
    } catch (err) {
      setError("Erreur lors de la déconnexion");
    }
  };
  // -----------------------------------------------------------

  // Écoute de l'état de connexion utilisateur et chargement Firestore
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      
      if (currentUser) {
        // 1. Écouter les séances de l'utilisateur dans Firestore
        const sessionsRef = collection(db, "users", currentUser.uid, "sessions");
        const unsubSessions = onSnapshot(sessionsRef, (snapshot) => {
          const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
          setSessions(docs.sort((a, b) => (a.date < b.date ? 1 : -1)));
        });

        // 2. Écouter le profil de force de l'utilisateur
        const profileRef = doc(db, "users", currentUser.uid, "profile", "force");
        const unsubProfile = onSnapshot(profileRef, (docSnap) => {
          if (docSnap.exists()) setProfile(docSnap.data());
        });

        return () => {
          unsubSessions();
          unsubProfile();
        };
      } else {
        // Si déconnecté, fallback sur le localStorage
        try {
          const savedSessions = localStorage.getItem("sessions");
          if (savedSessions) setSessions(JSON.parse(savedSessions));
          else setSessions([]);
        } catch (e) { setSessions([]); }

        try {
          const savedProfile = localStorage.getItem("profile");
          if (savedProfile) setProfile(JSON.parse(savedProfile));
        } catch (e) {}
      }
    });

    setLoaded(true);
    return () => unsubscribe();
  }, []);
  // Gestion du fichier GPX
  const handleFileSelected = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseGPX(text);
      setForm((f) => ({ ...f, type: "course", ...parsed }));
      setImportMsg(`Importé : ${parsed.distance} km depuis "${file.name}"`);
      setFormOpen(true);
    } catch (err) {
      setImportMsg(err.message || "Impossible de lire ce fichier.");
    }
  };

  const openForm = (type) => { setForm(emptyForm(type)); setFormOpen(true); };

  const saveForm = () => {
    if (!form.date) return;
    const clean = { ...form, id: form.id || uid() };
    const exists = sessions.some((s) => s.id === clean.id);
    const next = exists ? sessions.map((s) => (s.id === clean.id ? clean : s)) : [clean, ...sessions];
    persist(next.sort((a, b) => (a.date < b.date ? 1 : -1)));
    setFormOpen(false);
  };

  const removeSession = (id) => persist(sessions.filter((s) => s.id !== id));

  // Calculs hebdomadaires
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const thisWeek = sessions.filter((s) => new Date(s.date) >= weekAgo);
  const totalKm = thisWeek.filter((s) => s.type === "course" && s.distance).reduce((a, s) => a + parseFloat(s.distance || 0), 0);
  const weekCount = thisWeek.length;

  const filtered = useMemo(
    () => (tab === "overview" || tab === "all" ? sessions : sessions.filter((s) => s.type === tab)),
    [tab, sessions]
  );
  const byType = (t) => sessions.filter((s) => s.type === t).length;

  const numProfile = {
    poids: parseFloat(profile.poids) || 0,
    squat: parseFloat(profile.squat) || 0,
    deadlift: parseFloat(profile.deadlift) || 0,
    bench: parseFloat(profile.bench) || 0,
  };
  const ranks = useMemo(() => computeRanks(sessions, numProfile), [sessions, profile]);

 return (
    <div className="min-h-screen bg-[#090B11] text-[#EAEDF5] pb-28 font-sans">
      
      {/* Header */}
      <div className="px-5 pt-7 pb-4 sticky top-0 bg-[#090B11]/95 backdrop-blur z-10 border-b border-[#1B202C]">
        <div className="relative flex items-center justify-between">
          
          {/* Titre */}
          <h1 className="font-orbitron font-extrabold text-xl uppercase tracking-widest text-[#EAEDF5]">
            PRIME LEVEL
          </h1>

          {/* Bouton profil / connexion */}
          <div className="relative">
            <button 
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="w-9 h-9 rounded-full bg-[#1B202C] border border-[#2A3040] flex items-center justify-center overflow-hidden active:scale-95 transition"
            >
              {user && user.photoURL ? (
                <img src={user.photoURL} alt="Profil" className="w-full h-full object-cover" />
              ) : (
                <User size={18} color={user ? "#33F7FF" : "#5A6072"} />
              )}
            </button>

            {/* Menu déroulant */}
            {userMenuOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-[#131722] border border-[#1F2530] rounded-xl shadow-2xl py-2 z-30">
                {user ? (
                  <div>
                    <div className="px-3 py-2 border-b border-[#1F2530]">
                      <p className="text-xs font-medium text-[#EAEDF5] truncate">{user.displayName || "Athlète"}</p>
                      <p className="text-[10px] text-[#5A6072] truncate">{user.email}</p>
                    </div>
                    <button 
                      onClick={handleLogout} 
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#FF9B8A] hover:bg-[#1B202C] text-left"
                    >
                      <LogOut size={14} /> Déconnexion
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={handleGoogleLogin} 
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#33F7FF] hover:bg-[#1B202C] text-left font-medium"
                  >
                    <LogIn size={14} /> Connexion Google
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Bouton d'import GPX */}
        <button
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium border border-dashed transition-colors hover:border-[#33F7FF]/50"
          style={{ borderColor: "#2A3040", color: "#8A91A8" }}
        >
          <Upload size={15} /> Importer un fichier GPX (Strava)
        </button>
        <input ref={fileInputRef} type="file" accept=".gpx" className="hidden" onChange={handleFileSelected} />
        
        {importMsg && (
          <div className="mt-2 text-xs font-mono px-1 text-center" style={{ color: importMsg.startsWith("Importé") ? "#3DDC97" : "#FF9B8A" }}>
            {importMsg}
          </div>
        )}
      </div>

      {/* Le reste de ton application (Vues, Modals, Navigation) continue en dessous... */}
      {!loaded ? (
        <div className="px-5 py-10 text-[#5A6072] font-mono text-sm">Chargement…</div>
      ) : (
        <>
          {tab === "overview" && (
            <div className="px-5 pt-5 space-y-5">
              
              {/* Rank Hero */}
              <div className="rounded-2xl p-5 border border-[#1F2530]" style={{ background: "radial-gradient(circle at 30% 20%, #151A26, #0B0E15)" }}>
                <div className="flex items-center gap-4">
                  <RankBadge rank={ranks.overall} size={76} />
                  <div className="flex-1">
                    <div className="text-[11px] uppercase tracking-widest text-[#5A6072] font-display">Ligue générale</div>
                    <div className="font-orbitron text-xl font-bold" style={{ color: ranks.overall ? ranks.overall.color : "#5A6072" }}>
                      {ranks.overall ? ranks.overall.name.toUpperCase() : "NON CLASSÉ"}
                    </div>
                    <div className="mt-2">
                      <XPBar rank={ranks.overall} color={ranks.overall ? ranks.overall.color : "#3A404F"} />
                    </div>
                    <div className="text-[10px] font-mono text-[#5A6072] mt-1">
                      {ranks.overall 
                        ? `${Math.round(ranks.overall.frac * 100)}% vers ${RANK_NAMES[Math.min(4, ranks.overall.idx + 1)]} · meilleur que ~${percentileFromScore(ranks.overall.score)}% des pratiquants` 
                        : "Log une séance pour démarrer"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Rangs par discipline */}
              <div className="grid grid-cols-3 gap-3">
                {["course", "force", "hyrox"].map((key) => {
                  const t = TYPES[key];
                  const r = ranks[key];
                  return (
                    <button
                      key={key}
                      onClick={() => (key === "force" ? setProfileOpen(true) : setTab(key))}
                      className="rounded-xl bg-[#131722] border border-[#1F2530] p-3 flex flex-col items-center gap-2 active:scale-95 transition"
                    >
                      <RankBadge rank={r} size={44} showLabel={false} />
                      <span className="text-[10px] uppercase font-display tracking-wide" style={{ color: t.color }}>{t.label}</span>
                      <span className="text-[10px] font-mono" style={{ color: r ? r.color : "#5A6072" }}>{r ? r.name : "—"}</span>
                      {r && <span className="text-[9px] font-mono text-[#454B5C]">Top {100 - percentileFromScore(r.score)}%</span>}
                    </button>
                  );
                })}
              </div>

              {/* Statistiques de la semaine */}
              <div className="rounded-2xl bg-[#131722] border border-[#1F2530] p-4 flex items-center justify-between">
                <div>
                  <div className="font-mono text-3xl font-bold leading-none">{weekCount}<span className="text-sm text-[#5A6072]"> séances</span></div>
                  <div className="text-xs text-[#5A6072] mt-1">cette semaine{totalKm > 0 ? ` · ${totalKm.toFixed(1)} km` : ""}</div>
                </div>
                <TrendingUp size={22} color="#33F7FF" />
              </div>

              {/* Compteurs par type */}
              <div className="grid grid-cols-3 gap-3">
                {Object.entries(TYPES).map(([key, t]) => {
                  const Icon = getDisciplineIcon(key);
                  return (
                    <button key={key} onClick={() => setTab(key)} className="rounded-xl bg-[#131722] border border-[#1F2530] p-3 text-left active:scale-95 transition">
                      <Icon size={18} color={t.color} />
                      <div className="font-mono text-xl font-bold mt-2">{byType(key)}</div>
                      <div className="text-xs text-[#5A6072]">{t.label}</div>
                    </button>
                  );
                })}
              </div>

              {/* Séances récentes */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-display uppercase text-sm tracking-wider text-[#5A6072]">Séances récentes</h2>
                  {sessions.length > 5 && (
                    <button onClick={() => setTab("all")} className="text-xs text-[#5A6072] flex items-center gap-1">
                      Tout voir <ChevronRight size={12} />
                    </button>
                  )}
                </div>
                <SessionList items={sessions.slice(0, 5)} onDelete={removeSession} onEdit={(s) => { setForm(s); setFormOpen(true); }} />
              </div>

              <div className="text-[10px] font-mono text-[#3E4453] text-center px-4 leading-relaxed">
                Les rangs sont des estimations basées sur des repères sportifs généraux, pas des données scientifiques précises.
              </div>
            </div>
          )}

          {tab !== "overview" && (
            <div className="px-5 pt-5">
              {(tab === "course" || tab === "force" || tab === "hyrox") && (
                <DisciplineDetail discKey={tab} rank={ranks[tab]} />
              )}
              <h2 className="font-display uppercase text-sm tracking-wider text-[#5A6072] mb-3">
                {tab === "all" ? "Toutes les séances" : TYPES[tab].label}
              </h2>
              <SessionList items={filtered} onDelete={removeSession} onEdit={(s) => { setForm(s); setFormOpen(true); }} />
            </div>
          )}
        </>
      )}

      {error && <div className="fixed bottom-24 left-5 right-5 bg-[#3A1F1F] text-[#FF9B8A] text-xs rounded-lg px-3 py-2 font-mono">{error}</div>}

      {/* Barre de navigation basse */}
      <div className="fixed bottom-0 left-0 right-0 bg-[#0D1017] border-t border-[#1F2530] px-3 py-2 flex items-center justify-between gap-1">
        <NavBtn active={tab === "overview"} onClick={() => setTab("overview")} icon={LayoutGrid} label="Vue" color="#33F7FF" />
        <NavBtn active={tab === "course"} onClick={() => setTab("course")} icon={Activity} label="Course" color="#FF5A3C" />
        <button onClick={() => openForm(tab === "force" ? "force" : tab === "hyrox" ? "hyrox" : "course")}
          className="w-14 h-14 rounded-full flex items-center justify-center -mt-6"
          style={{ background: "#33F7FF", boxShadow: "0 0 18px #33F7FF88" }}>
          <Plus size={26} color="#090B11" strokeWidth={2.5} />
        </button>
        <NavBtn active={tab === "force"} onClick={() => setTab("force")} icon={Dumbbell} label="Force" color="#3DDC97" />
        <NavBtn active={tab === "hyrox"} onClick={() => setTab("hyrox")} icon={Zap} label="Hyrox" color="#FFC53D" />
      </div>

      {/* Modal du profil Force */}
      {profileOpen && (
        <div className="fixed inset-0 bg-black/70 z-20 flex items-end" onClick={() => setProfileOpen(false)}>
          <div className="bg-[#0D1017] w-full rounded-t-2xl p-5 pb-8 modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display uppercase text-xl flex items-center gap-2"><Settings size={18} /> Profil de force</h3>
              <button onClick={() => setProfileOpen(false)}><X size={20} /></button>
            </div>
            <p className="text-xs text-[#7B8298] mb-4">Entre ton poids de corps et tes meilleures charges pour calculer ton rang Force.</p>
            <div className="space-y-3">
              <Field label="Poids de corps (kg)">
                <input type="number" value={profile.poids} onChange={(e) => setProfile((p) => ({ ...p, poids: e.target.value }))}
                  className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="80" />
              </Field>
              <Field label="Squat (kg)">
                <input type="number" value={profile.squat} onChange={(e) => setProfile((p) => ({ ...p, squat: e.target.value }))}
                  className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="100" />
              </Field>
              <Field label="Soulevé de terre (kg)">
                <input type="number" value={profile.deadlift} onChange={(e) => setProfile((p) => ({ ...p, deadlift: e.target.value }))}
                  className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="120" />
              </Field>
              <Field label="Développé couché (kg)">
                <input type="number" value={profile.bench} onChange={(e) => setProfile((p) => ({ ...p, bench: e.target.value }))}
                  className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="70" />
              </Field>
            </div>
            <button onClick={() => { persistProfile(profile); setProfileOpen(false); }}
              className="w-full mt-5 py-3 rounded-lg font-display uppercase tracking-wide text-lg"
              style={{ background: "#33F7FF", color: "#090B11" }}>
              Enregistrer
            </button>
          </div>
        </div>
      )}

      {/* Modal du formulaire de séance */}
      {formOpen && (
        <div className="fixed inset-0 bg-black/70 z-20 flex items-end" onClick={() => setFormOpen(false)}>
          <div className="bg-[#0D1017] w-full rounded-t-2xl p-5 pb-8 max-h-[85vh] overflow-y-auto modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display uppercase text-xl">{form.id ? "Modifier" : "Nouvelle séance"}</h3>
              <button onClick={() => setFormOpen(false)}><X size={20} /></button>
            </div>

            <div className="flex gap-2 mb-4">
              {Object.entries(TYPES).map(([key, t]) => (
                <button key={key} onClick={() => setForm((f) => ({ ...f, type: key }))}
                  className="flex-1 py-2 rounded-lg text-sm font-medium border transition"
                  style={{ background: form.type === key ? t.color : "transparent", color: form.type === key ? "#090B11" : "#EAEDF5", borderColor: form.type === key ? t.color : "#262C3A" }}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <Field label="Date">
                <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm" />
              </Field>

              {form.type === "course" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Distance (km)">
                    <input type="number" step="0.1" value={form.distance} onChange={(e) => setForm((f) => ({ ...f, distance: e.target.value }))}
                      className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="5.0" />
                  </Field>
                  <Field label="Durée (min)">
                    <input type="number" value={form.duree} onChange={(e) => setForm((f) => ({ ...f, duree: e.target.value }))}
                      className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="30" />
                  </Field>
                  <Field label="FC moyenne">
                    <input type="number" value={form.fc} onChange={(e) => setForm((f) => ({ ...f, fc: e.target.value }))}
                      className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="150" />
                  </Field>
                </div>
              )}

              {(form.type === "force" || form.type === "hyrox") && (
                <Field label="Durée (min)">
                  <input type="number" value={form.duree} onChange={(e) => setForm((f) => ({ ...f, duree: e.target.value }))}
                    className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm font-mono" placeholder="45" />
                </Field>
              )}

              <Field label={form.type === "course" ? "Notes (allure, ressenti…)" : form.type === "force" ? "Exercices & charges" : "Stations & temps"}>
                <textarea value={form.details} onChange={(e) => setForm((f) => ({ ...f, details: e.target.value }))}
                  rows={3} className="w-full bg-[#161B26] rounded-lg px-3 py-2 text-sm resize-none"
                  placeholder={form.type === "course" ? "6x400m, allure 1'45..." : form.type === "force" ? "Squats 4x10 @60kg..." : "1km run, wall balls, burpees..."} />
              </Field>

              <Field label="Ressenti">
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => setForm((f) => ({ ...f, ressenti: String(n) }))}
                      className="flex-1 py-2 rounded-lg text-sm font-mono"
                      style={{ background: Number(form.ressenti) === n ? "#33F7FF" : "#161B26", color: Number(form.ressenti) === n ? "#090B11" : "#7B8298" }}>
                      {n}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            <button onClick={saveForm} className="w-full mt-5 py-3 rounded-lg font-display uppercase tracking-wide text-lg" style={{ background: "#33F7FF", color: "#090B11" }}>
              Enregistrer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

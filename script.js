const URL = "./jc_latest_tm_model/";

let model, webcam, labelContainer, maxPredictions;
let lastDetectedReaction = "";
let lastEmojiTime = 0;
let isStreaming = false;
let rafId = null;
let logCount = 0;

const emojiMap = {
    "like":       "👍",
    "heart":      "💖",
    "clap":       "👏",
    "raise hand": "✋",
    "happy":      "😄",
    "listening":  "👂"
};

// ═══════════════════════════════════════════════════════
//  VADER-STYLE SENTIMENT ENGINE
//  Each reaction is assigned valence scores matching
//  VADER's lexicon philosophy:
//    pos  → contributes positive compound score (+)
//    neg  → contributes negative compound score (-)
//    neu  → treated as neutral (passive, listening)
//    inq  → inquisitive / uncertain (slightly negative
//            in VADER terms — unresolved sentiment)
//
//  Compound formula mirrors VADER:
//    sum = Σ valence scores
//    compound = sum / √(sum² + α)   where α = 15
//    clamped to [-1, +1]
// ═══════════════════════════════════════════════════════

const VADER_LEXICON = {
    "happy":      { valence:  2.9, bucket: "pos" },
    "heart":      { valence:  2.7, bucket: "pos" },
    "like":       { valence:  2.2, bucket: "pos" },
    "clap":       { valence:  2.5, bucket: "pos" },
    "listening":  { valence:  0.0, bucket: "neu" },
    "raise hand": { valence: -0.6, bucket: "inq" }  // unresolved intent = mild negative
};

// running event history for scoring
const sessionEvents = [];   // array of bucket strings: "pos" | "neu" | "inq"
let sessionValenceSum = 0;  // running Σ valence

function vaderCompound(sum) {
    const alpha = 15;
    return sum / Math.sqrt(sum * sum + alpha);
}

function updateVibePanel() {
    if (sessionEvents.length === 0) return;

    const total = sessionEvents.length;
    const counts = { pos: 0, neu: 0, inq: 0 };
    sessionEvents.forEach(b => counts[b]++);

    const posP = Math.round((counts.pos / total) * 100);
    const neuP = Math.round((counts.neu / total) * 100);
    const inqP = 100 - posP - neuP;

    // update breakdown bars
    setBar("bar-pos", "pct-pos", posP);
    setBar("bar-neu", "pct-neu", neuP);
    setBar("bar-inq", "pct-inq", Math.max(0, inqP));

    // compound score
    const compound = vaderCompound(sessionValenceSum);
    const displayScore = compound.toFixed(3);

    const scoreEl = document.getElementById("vibe-score");
    if (scoreEl) scoreEl.textContent = displayScore;

    // needle position: compound is [-1,+1], map to [0%,100%]
    const needlePct = ((compound + 1) / 2) * 100;
    const needle = document.getElementById("vibe-needle");
    if (needle) needle.style.left = `${Math.max(2, Math.min(98, needlePct))}%`;

    // fill bar: from center (50%) toward positive or negative
    const fill = document.getElementById("vibe-meter-fill");
    if (fill) {
        if (compound >= 0) {
            fill.style.left  = "50%";
            fill.style.width = `${needlePct - 50}%`;
            fill.style.background = "var(--vibe-pos)";
        } else {
            fill.style.left  = `${needlePct}%`;
            fill.style.width = `${50 - needlePct}%`;
            fill.style.background = "var(--vibe-neg)";
        }
    }

    // determine vibe label + verdict
    let vibeName, vibeVerdict, vibeClass;

    // VADER thresholds: compound >= 0.05 = positive, <= -0.05 = negative
    if (compound >= 0.05) {
        if (posP >= 60) {
            vibeName    = "Enthusiastic";
            vibeVerdict = `Strong positive energy — lots of reactions like claps, likes, and happiness detected. The audience is engaged and upbeat.`;
            vibeClass   = "vibe-pos";
        } else {
            vibeName    = "Positive";
            vibeVerdict = `The session has a generally positive tone. Engagement is good with a mix of affirmative reactions.`;
            vibeClass   = "vibe-pos";
        }
    } else if (compound <= -0.05) {
        if (inqP >= 40) {
            vibeName    = "Inquisitive";
            vibeVerdict = `High volume of hand-raises detected. The audience has questions — consider pausing for a Q&A or clarification.`;
            vibeClass   = "vibe-inq";
        } else {
            vibeName    = "Uncertain";
            vibeVerdict = `The session is trending slightly negative. Engagement may be low or the audience seems unsure.`;
            vibeClass   = "vibe-neg";
        }
    } else {
        if (neuP >= 50) {
            vibeName    = "Attentive";
            vibeVerdict = `Mostly listening detected. The audience appears focused and absorbing the content — a calm, neutral session.`;
            vibeClass   = "vibe-neu";
        } else {
            vibeName    = "Mixed";
            vibeVerdict = `Signals are balanced across different reactions. No dominant emotion detected yet — keep going.`;
            vibeClass   = "vibe-neu";
        }
    }

    // update badge
    const badge = document.getElementById("vibe-badge");
    if (badge) {
        badge.textContent = vibeName;
        badge.className   = `panel-badge vibe-badge ${vibeClass}`;
    }

    // update verdict
    const verdict = document.getElementById("vibe-verdict");
    if (verdict) {
        verdict.textContent = vibeVerdict;
        verdict.className   = `vibe-verdict ${vibeClass}`;
    }
}

function setBar(barId, pctId, pct) {
    const bar = document.getElementById(barId);
    const lbl = document.getElementById(pctId);
    if (bar) bar.style.width = `${pct}%`;
    if (lbl) lbl.textContent = `${pct}%`;
}

// ═══════════════════════════════════════════════════════
//  CAMERA / MODEL
// ═══════════════════════════════════════════════════════

async function init() {
    if (isStreaming) return;

    if (location.protocol === 'file:') {
        alert('Please serve this page over http://localhost or a web server (not file://) to access the camera.');
        return;
    }

    try {
        const modelURL    = URL + "model.json";
        const metadataURL = URL + "metadata.json";
        model = await tmImage.load(modelURL, metadataURL);
        maxPredictions = model.getTotalClasses();

        webcam = new tmImage.Webcam(400, 400, true);
        await webcam.setup();
        await webcam.play();
        rafId = window.requestAnimationFrame(loop);

        document.getElementById("webcam-container").appendChild(webcam.canvas);

        labelContainer = document.getElementById("label-container");
        labelContainer.innerHTML = "";
        for (let i = 0; i < maxPredictions; i++) {
            const div = document.createElement("div");
            labelContainer.appendChild(div);
        }

        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "none";

        // set initial vibe verdict
        const verdict = document.getElementById("vibe-verdict");
        if (verdict) verdict.textContent = "Analyzing reactions… results will appear as events are logged.";

        setLiveState(true);
        toggleCameraButton(true);
        isStreaming = true;

    } catch (err) {
        console.error('Init error:', err);
        alert('Error starting camera or loading model: ' + (err && err.message ? err.message : err));
    }
}

async function loop() {
    if (!webcam) return;
    webcam.update();
    await predict();
    rafId = window.requestAnimationFrame(loop);
}

function setLiveState(live) {
    const dot   = document.getElementById("live-dot");
    const label = document.getElementById("live-label");
    const badge = document.getElementById("feed-status");
    if (live) {
        dot && dot.classList.add("active");
        if (label) label.textContent = "Live";
        if (badge) badge.textContent = "Active";
    } else {
        dot && dot.classList.remove("active");
        if (label) label.textContent = "Offline";
        if (badge) badge.textContent = "No Signal";
    }
}

function toggleCameraButton(streaming) {
    const btn = document.getElementById('camera-btn');
    if (!btn) return;
    if (streaming) {
        btn.textContent = 'Stop Camera';
        btn.onclick = stopCamera;
        btn.classList.remove('btn-primary-action');
        btn.classList.add('btn-stop');
    } else {
        btn.textContent = 'Start Camera';
        btn.onclick = init;
        btn.classList.remove('btn-stop');
        btn.classList.add('btn-primary-action');
    }
}

async function stopCamera() {
    if (!isStreaming) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    if (webcam) {
        webcam.stop();
        const container = document.getElementById('webcam-container');
        if (container && webcam.canvas && container.contains(webcam.canvas)) {
            container.removeChild(webcam.canvas);
        }
        webcam = null;
    }

    if (labelContainer) labelContainer.innerHTML = '';
    const overlay = document.getElementById('effect-overlay');
    if (overlay) overlay.innerHTML = '';

    lastDetectedReaction = '';
    isStreaming = false;
    setLiveState(false);
    toggleCameraButton(false);
}

async function predict() {
    const prediction = await model.predict(webcam.canvas);

    let highestProb       = 0;
    let currentBestAction = "";
    let highestIndex      = 0;

    for (let i = 0; i < maxPredictions; i++) {
        const prob  = prediction[i].probability;
        const label = prediction[i].className;

        if (labelContainer.childNodes[i]) {
            labelContainer.childNodes[i].textContent = label + ": " + (prob * 100).toFixed(0) + "%";
            labelContainer.childNodes[i].classList.remove("active-label");
        }

        if (prob > highestProb) {
            highestProb       = prob;
            currentBestAction = label;
            highestIndex      = i;
        }
    }

    if (highestProb > 0.60 && labelContainer.childNodes[highestIndex]) {
        labelContainer.childNodes[highestIndex].classList.add("active-label");
    }

    const cleanAction = currentBestAction.toLowerCase().trim();

    if (highestProb > 0.90 && cleanAction !== "neutral" && cleanAction !== "background") {
        const now = Date.now();
        if (cleanAction !== lastDetectedReaction) {
            logToChat(currentBestAction);
            showEffect(cleanAction);
            recordSentiment(cleanAction);
            lastDetectedReaction = cleanAction;
            lastEmojiTime = now;
        } else if (now - lastEmojiTime > 1500) {
            showEffect(cleanAction);
            lastEmojiTime = now;
        }
    } else if (highestProb > 0.90) {
        lastDetectedReaction = "neutral";
    }
}

function recordSentiment(cleanAction) {
    const entry = VADER_LEXICON[cleanAction];
    if (!entry) return;
    sessionEvents.push(entry.bucket);
    sessionValenceSum += entry.valence;
    updateVibePanel();
}

function showEffect(reaction) {
    if (reaction === "listening") return;
    const emojiSymbol = emojiMap[reaction];
    if (!emojiSymbol) return;

    const overlay = document.getElementById("effect-overlay");
    if (!overlay) return;

    for (let i = 0; i < 5; i++) {
        const emoji = document.createElement("div");
        emoji.innerText = emojiSymbol;
        emoji.className = "emoji-effect";
        emoji.style.left           = `${10 + Math.random() * 80}%`;
        emoji.style.animationDelay = `${Math.random() * 0.5}s`;
        overlay.appendChild(emoji);
        setTimeout(() => emoji.remove(), 2500);
    }
}

function logToChat(reaction) {
    const chatBox = document.getElementById("chat-box");

    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "none";

    const now        = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const entry     = document.createElement("div");
    entry.className = "log-entry";

    const lowerReaction = reaction.toLowerCase().trim();
    let actionText = "";
    if      (lowerReaction === "raise hand") actionText = `is <b>raising their hand</b>`;
    else if (lowerReaction === "clap")       actionText = `is <b>clapping</b>`;
    else if (lowerReaction === "listening")  actionText = `is <b>listening intently</b>`;
    else                                     actionText = `showed a <b>${reaction}</b> reaction`;

    entry.innerHTML = `<div class="log-time">${timeString}</div><strong>User</strong> ${actionText}.`;
    chatBox.prepend(entry);

    logCount++;
    const badge = document.getElementById("log-count");
    if (badge) badge.textContent = logCount + (logCount === 1 ? " event" : " events");
}

// ── THEME ────────────────────────────────────────────
let isLight = false;

function toggleTheme() {
    isLight = !isLight;
    const btn = document.getElementById('theme-btn');
    if (isLight) {
        document.body.classList.add('light-mode');
        if (btn) btn.textContent = 'Dark Mode';
    } else {
        document.body.classList.remove('light-mode');
        if (btn) btn.textContent = 'Light Mode';
    }
}
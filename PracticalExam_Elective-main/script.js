const URL = "./jc_tm-my-image-model/";

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

        // clear empty state from chat box if it's there
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "none";

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
        dot  && dot.classList.add("active");
        if (label) label.textContent = "Live";
        if (badge) badge.textContent = "Active";
    } else {
        dot  && dot.classList.remove("active");
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

    let highestProb      = 0;
    let currentBestAction = "";
    let highestIndex     = 0;

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

    // highlight the winning label badge
    if (highestProb > 0.60 && labelContainer.childNodes[highestIndex]) {
        labelContainer.childNodes[highestIndex].classList.add("active-label");
    }

    const cleanAction = currentBestAction.toLowerCase().trim();

    if (highestProb > 0.90 && cleanAction !== "neutral" && cleanAction !== "background") {
        const now = Date.now();
        if (cleanAction !== lastDetectedReaction) {
            logToChat(currentBestAction);
            showEffect(cleanAction);
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
        emoji.style.left         = `${10 + Math.random() * 80}%`;
        emoji.style.animationDelay = `${Math.random() * 0.5}s`;
        overlay.appendChild(emoji);
        setTimeout(() => emoji.remove(), 2500);
    }
}

function logToChat(reaction) {
    const chatBox = document.getElementById("chat-box");

    // hide empty state placeholder
    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "none";

    const now        = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const entry      = document.createElement("div");
    entry.className  = "log-entry";

    const lowerReaction = reaction.toLowerCase().trim();
    let actionText = "";
    if      (lowerReaction === "raise hand")  actionText = `is <b>raising their hand</b>`;
    else if (lowerReaction === "clap")        actionText = `is <b>clapping</b>`;
    else if (lowerReaction === "listening")   actionText = `is <b>listening intently</b>`;
    else                                      actionText = `showed a <b>${reaction}</b> reaction`;

    entry.innerHTML = `<div class="log-time">${timeString}</div><strong>User</strong> ${actionText}.`;
    chatBox.prepend(entry);

    // update log count badge
    logCount++;
    const badge = document.getElementById("log-count");
    if (badge) badge.textContent = logCount + (logCount === 1 ? " event" : " events");
}

// ── THEME ────────────────────────────────────────
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
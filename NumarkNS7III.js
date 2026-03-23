// NumarkNS7III.js — Mixxx 2.4+ script for Numark NS7III
// High-Stability Decoupled Mapping (No Pilot / Max Torque)

var NS7III = {};

// ── Constants ─────────────────────────────────────────────────────
NS7III.MOTOR_CH   = [2, 3]; 
NS7III.RAMP_STEPS = 18;
NS7III.RES        = 3600; 

NS7III.motorRunning  = [false, false];
NS7III.motorReverse  = [false, false];
NS7III.motorTimer    = [0, 0];
NS7III.motorRampStep = [0, 0];

NS7III.leftDeck  = 1;
NS7III.rightDeck = 2;

NS7III.padMode    = ["hotcue", "hotcue"];
NS7III.ROLL_SIZES = ["0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8"];
NS7III.shiftHeld  = [false, false];

NS7III.jogLastCoarse = [0, 0];
NS7III.jogLastPB     = [8192, 8192];
NS7III.isTouching    = [false, false];
NS7III.touchTimer    = [0, 0];
NS7III.ledConns      = [[], [], [], []];

// ── Helpers ───────────────────────────────────────────────────────
NS7III.deckForSide = function(side) { return side === 0 ? NS7III.leftDeck : NS7III.rightDeck; };
NS7III._sideForDeck = function(deck) { 
    if (deck == 1 || deck == 3) return 0; 
    if (deck == 2 || deck == 4) return 1; 
    return 0;
};

// ── Motor Control ─────────────────────────────────────────────────
NS7III.motorSetDirection = function(side, reverse) {
    var ch = NS7III.MOTOR_CH[side];
    NS7III.motorReverse[side] = reverse;
    midi.sendShortMsg(0xB0 | (ch - 1), reverse ? 70 : 69, reverse ? 1 : 0);
};

NS7III.motorStart = function(side) {
    var ch = NS7III.MOTOR_CH[side];
    midi.sendShortMsg(0xB0, 75, 0); // Global Enable
    midi.sendShortMsg(0xB0 | (ch - 1), 65, 127); // Motor Start
    midi.sendShortMsg(0xB0 | (ch - 1), 71, 127); // MAX TORQUE (No stall)
    NS7III.motorSetDirection(side, NS7III.motorReverse[side]);
    NS7III.motorRunning[side] = true;
    NS7III.motorRampStep[side] = 0;

    if (NS7III.motorTimer[side]) engine.stopTimer(NS7III.motorTimer[side]);
    NS7III.motorTimer[side] = engine.beginTimer(50, function() { NS7III._rampTick(side); });
};

NS7III._rampTick = function(side) {
    if (NS7III.motorRampStep[side] >= NS7III.RAMP_STEPS) {
        engine.stopTimer(NS7III.motorTimer[side]); NS7III.motorTimer[side] = 0; return;
    }
    var ch = NS7III.MOTOR_CH[side];
    midi.sendShortMsg(0xB0 | (ch - 1), 73, Math.round(NS7III.motorRampStep[side] / (NS7III.RAMP_STEPS - 1) * 100));
    midi.sendShortMsg(0xB0 | (ch - 1), 105, 64);
    NS7III.motorRampStep[side]++;
};

NS7III.motorStop = function(side) {
    var ch = NS7III.MOTOR_CH[side];
    midi.sendShortMsg(0xB0 | (ch - 1), 73, 0);
    midi.sendShortMsg(0xB0 | (ch - 1), 66, 127);
    NS7III.motorRunning[side] = false;
};

// ── Application Master Clock Tracking (Zero-Warble) ──────────────
NS7III.jogSpin = function(channel, control, value, status, group) {
    var side = (status & 0x0F) - 1;
    if (side < 0 || side > 1) return;
    var deck = NS7III.deckForSide(side);

    var delta = value - NS7III.jogLastCoarse[side];
    if (delta > 64) delta -= 128;
    else if (delta < -64) delta += 128;
    
    NS7III.jogLastCoarse[side] = value;
    if (delta === 0) return;

    // AUDIO DECOUPLING:
    // Playhead ONLY moves if physical touch is active.
    if (NS7III.isTouching[side]) {
        if (!engine.isScratching(deck)) {
            engine.scratchEnable(deck, NS7III.RES, 33.333, 0.95, 0.95/32.0, false);
        }
        engine.scratchTick(deck, delta);
    } else {
        // HANDS OFF: Hard-lock playhead to Mixxx Quartz Clock.
        if (engine.isScratching(deck)) {
            engine.scratchDisable(deck, true);
        }
    }
};

NS7III.jogPB = function(channel, control, value, status, group) {
    var side = (status & 0x0F) - 1;
    if (side < 0 || side > 1) return;
    
    var currentPB = (value << 7) | control;
    var deltaPB = currentPB - NS7III.jogLastPB[side];
    if (deltaPB > 8192) deltaPB -= 16384;
    else if (deltaPB < -8192) deltaPB += 16384;

    // Detect Slip: Motor at 33 RPM sends ~110 units/packet.
    var expected = NS7III.motorRunning[side] ? 110 : 0;
    if (Math.abs(deltaPB - expected) > 20) {
        NS7III.isTouching[side] = true;
        if (NS7III.touchTimer[side]) engine.stopTimer(NS7III.touchTimer[side]);
        // Release Timer (50ms): Snaps control back to Mixxx clock instantly.
        NS7III.touchTimer[side] = engine.beginTimer(50, function() {
            NS7III.touchTimer[side] = 0; NS7III.isTouching[side] = false;
        }, true);
    }
    NS7III.jogLastPB[side] = currentPB;
};

// ── Transport & Pitch ───────────────────────────────────────────
NS7III.play = function(channel) {
    var side = NS7III._sideForDeck(channel), deck = NS7III.deckForSide(side);
    var group = "[Channel" + deck + "]";
    var playing = engine.getValue(group, "play");
    
    if (playing) {
        engine.setValue(group, "play", 0);
        NS7III.motorStop(side);
    } else {
        engine.setValue(group, "play", 1);
        NS7III.motorStart(side);
    }
};

NS7III.pitch = function(deck, n, v) {
    var norm = (v-63.5)/63.5; 
    if (Math.abs(norm) < 0.08) norm = 0;
    engine.setValue("[Channel" + deck + "]", "rate", norm);
};

NS7III.pitchA = function(c, n, v) { NS7III.pitch(NS7III.leftDeck, n, v); };
NS7III.pitchB = function(c, n, v) { NS7III.pitch(NS7III.rightDeck, n, v); };

// ── Performance & LEDs ────────────────────────────────────────────
NS7III.shift = function(c, n, v) { NS7III.shiftHeld[NS7III._sideForDeck(c)] = (v > 0); };
NS7III.cue = function(c, n, v) { engine.setValue("[Channel" + c + "]", "cue_default", v > 0 ? 1 : 0); };
NS7III.sync = function(c, n, v) { if (v > 0) engine.setValue("[Channel" + c + "]", "sync_enabled", !engine.getValue("[Channel" + c + "]", "sync_enabled")); };
NS7III.pad = function(c, n, v) { var p = n - 70, s = NS7III._sideForDeck(c); if (NS7III.padMode[s] === "hotcue") { if (v > 0) engine.setValue("[Channel" + c + "]", "hotcue_" + p + "_" + (NS7III.shiftHeld[s] ? "clear" : "activate"), 1); } else { engine.setValue("[Channel" + c + "]", "beatlooproll_" + ["0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8"][p-1] + "_activate", v > 0 ? 1 : 0); } };

NS7III._connectLedsForDeck = function(deck) {
    var g = "[Channel" + deck + "]", s = 0x90 | deck;
    [["52","play_indicator"],["51","cue_indicator"],["50","sync_enabled"]].forEach(function(m){
        var c = engine.makeConnection(g, m[1], function(v){ midi.sendShortMsg(s, parseInt(m[0]), v?0x7F:0x00); });
        c.trigger(); NS7III.ledConns[deck-1].push(c);
    });
};

NS7III.init = function() {
    midi.sendShortMsg(0xB0, 71, 0); midi.sendShortMsg(0xB0, 74, 0); midi.sendShortMsg(0xB0, 75, 0);
    NS7III.ledConns = [[],[],[],[]];
    for(var d=1;d<=4;d++) NS7III._connectLedsForDeck(d);
};

NS7III.shutdown = function() {
    for(var s=0;s<2;s++) { if (NS7III.motorTimer[s]) engine.stopTimer(NS7III.motorTimer[s]); if (NS7III.motorRunning[s]) NS7III.motorStop(s); }
    for(var n=2;n<=5;n++) midi.sendShortMsg(0x90, n, 0x00);
};

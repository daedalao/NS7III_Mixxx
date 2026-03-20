// NumarkNS7III.js — Mixxx 2.4+ script for Numark NS7III
// Handles: motor start/stop, jog scratch/nudge, deck layer switching
// Derived from djcmd ns7iii_map.h / djcmd_config.h
//
// Motor protocol (CC on ChN, N = 1-indexed MIDI channel):
//   CC65=127  START      CC66=127  STOP
//   CC69=0    FORWARD    CC70=1    REVERSE
//   CC73 0→100 ramp over RAMP_STEPS steps at 20Hz
//   CC75=0 on Ch1: global enable (sent once before first start)
//
// Physical motor channels (from CFG_MOTOR_CH_A/B in djcmd_config.h):
//   Left platter:  Ch2 (deck A and deck C via layer switch)
//   Right platter: Ch3 (deck B and deck D via layer switch)
//
// Layer state: NS7III.leftDeck / NS7III.rightDeck track which virtual
// deck (1-4) each physical platter is currently controlling.

var NS7III = {};

// ── Motor state ───────────────────────────────────────────────────
NS7III.MOTOR_CH   = [2, 3];     // left/right physical platter channels (1-indexed)
NS7III.RAMP_STEPS = 18;         // ~0.9s spinup at 20Hz (CFG_MOTOR_RAMP_STEPS)
NS7III.RAMP_MS    = 50;         // 20Hz interval

NS7III.motorRunning  = [false, false];
NS7III.motorTimer    = [0, 0];
NS7III.motorRampStep = [0, 0];
NS7III.globalInitDone = false;

// side: 0=left, 1=right
NS7III.motorStart = function(side) {
    var ch = NS7III.MOTOR_CH[side];
    if (!NS7III.globalInitDone) {
        NS7III.globalInitDone = true;
        midi.sendShortMsg(0xB0, 75, 0);   // CC75=0 global enable (Ch1)
    }
    midi.sendShortMsg(0xB0 | (ch - 1), 65, 127); // CC65=127 START
    midi.sendShortMsg(0xB0 | (ch - 1), 69, 0);   // CC69=0 FORWARD
    NS7III.motorRunning[side]  = true;
    NS7III.motorRampStep[side] = 0;
    if (NS7III.motorTimer[side]) engine.stopTimer(NS7III.motorTimer[side]);
    NS7III.motorTimer[side] = engine.beginTimer(NS7III.RAMP_MS, function() {
        NS7III._rampTick(side, ch);
    });
};

NS7III._rampTick = function(side, ch) {
    var step = NS7III.motorRampStep[side];
    if (step >= NS7III.RAMP_STEPS) {
        engine.stopTimer(NS7III.motorTimer[side]);
        NS7III.motorTimer[side] = 0;
        return;
    }
    var val = Math.round((step / (NS7III.RAMP_STEPS - 1)) * 100);
    midi.sendShortMsg(0xB0 | (ch - 1), 73, val);  // CC73 ramp value
    NS7III.motorRampStep[side]++;
};

NS7III.motorStop = function(side) {
    var ch = NS7III.MOTOR_CH[side];
    if (NS7III.motorTimer[side]) {
        engine.stopTimer(NS7III.motorTimer[side]);
        NS7III.motorTimer[side] = 0;
    }
    midi.sendShortMsg(0xB0 | (ch - 1), 73, 0);   // CC73=0 ramp to zero
    midi.sendShortMsg(0xB0 | (ch - 1), 66, 127); // CC66=127 STOP
    NS7III.motorRunning[side] = false;
};

// ── Layer state (which virtual deck each physical side controls) ──
NS7III.leftDeck  = 1;   // [Channel1] by default
NS7III.rightDeck = 2;   // [Channel2] by default

NS7III.deckForSide = function(side) {
    return side === 0 ? NS7III.leftDeck : NS7III.rightDeck;
};

NS7III.sideForMidiCh = function(midiCh) {
    // midiCh: 1-indexed. Ch2=left, Ch3=right (NS7III platter channels)
    return (midiCh === 2) ? 0 : 1;
};

// ── Play buttons — toggle play and start/stop motor ───────────────
NS7III._playToggle = function(side, channel) {
    var group = "[Channel" + channel + "]";
    var playing = engine.getValue(group, "play");
    if (playing) {
        engine.setValue(group, "play", 0);
        NS7III.motorStop(side);
    } else {
        engine.setValue(group, "play", 1);
        NS7III.motorStart(side);
    }
};

// play_a: Ch2 note 52 → left side, active deck
NS7III.playDeckA = function(channel, control, value, status, group) {
    if (value === 0) return;  // ignore Note Off
    var deck = NS7III.leftDeck;
    NS7III._playToggle(0, deck);
};

// play_b: Ch3 note 52 → right side, active deck
NS7III.playDeckB = function(channel, control, value, status, group) {
    if (value === 0) return;
    var deck = NS7III.rightDeck;
    NS7III._playToggle(1, deck);
};

// ── Deck layer selectors (Ch1 notes 2-5) ─────────────────────────
// deck_sel_1: left platter → Deck A
NS7III.deckSel1 = function(channel, control, value, status, group) {
    if (value === 0) return;
    if (NS7III.motorRunning[0]) NS7III.motorStop(0);
    NS7III.leftDeck = 1;
    midi.sendShortMsg(0x90, 2, 0x7F);  // led_deck_1 on
    midi.sendShortMsg(0x90, 4, 0x00);  // led_deck_3 off
};

// deck_sel_3: left platter → Deck C
NS7III.deckSel3 = function(channel, control, value, status, group) {
    if (value === 0) return;
    if (NS7III.motorRunning[0]) NS7III.motorStop(0);
    NS7III.leftDeck = 3;
    midi.sendShortMsg(0x90, 2, 0x00);  // led_deck_1 off
    midi.sendShortMsg(0x90, 4, 0x7F);  // led_deck_3 on
    // Resume motor if deck C is already playing
    if (engine.getValue("[Channel3]", "play")) NS7III.motorStart(0);
};

// deck_sel_2: right platter → Deck B
NS7III.deckSel2 = function(channel, control, value, status, group) {
    if (value === 0) return;
    if (NS7III.motorRunning[1]) NS7III.motorStop(1);
    NS7III.rightDeck = 2;
    midi.sendShortMsg(0x90, 3, 0x7F);  // led_deck_2 on
    midi.sendShortMsg(0x90, 5, 0x00);  // led_deck_4 off
};

// deck_sel_4: right platter → Deck D
NS7III.deckSel4 = function(channel, control, value, status, group) {
    if (value === 0) return;
    if (NS7III.motorRunning[1]) NS7III.motorStop(1);
    NS7III.rightDeck = 4;
    midi.sendShortMsg(0x90, 3, 0x00);  // led_deck_2 off
    midi.sendShortMsg(0x90, 5, 0x7F);  // led_deck_4 on
    if (engine.getValue("[Channel4]", "play")) NS7III.motorStart(1);
};

// ── Jog wheels ───────────────────────────────────────────────────
// NS7III jog encoding (from ns7iii_map.h set jog_ref_delta=0.0078125):
//   Center-64: value > 64 = forward, < 64 = backward
//   The pitch-bend axis (E1/E2) is used when touching the top surface

NS7III.scratchEnabled = [false, false];  // per side, set by strip touch

// strip_a/b: Ch2/3 CC2 — touch strip toggles scratch mode
NS7III.stripTouch = function(channel, control, value, status, group) {
    var side = NS7III.sideForMidiCh(channel);
    var deck = NS7III.deckForSide(side);
    NS7III.scratchEnabled[side] = (value > 0);
    if (value > 0) {
        // Enable scratch with NS7III-appropriate parameters
        // 44100 Hz / 33.33 rpm = ~1323 samples per revolution
        engine.scratchEnable(deck, 128, 33.33, 0.125, 0.125 / 32, true);
    } else {
        engine.scratchDisable(deck, true);
    }
};

// jog_spin_a/b: Ch2/3 CC0 — incremental spin encoder (center-64)
NS7III.jogSpin = function(channel, control, value, status, group) {
    var side = NS7III.sideForMidiCh(channel);
    var deck = NS7III.deckForSide(side);
    var delta = value - 64;  // center-64: positive=fwd, negative=rev
    if (NS7III.scratchEnabled[side]) {
        engine.scratchTick(deck, delta);
    } else {
        // Nudge mode: small pitch bump
        var jogGroup = "[Channel" + deck + "]";
        engine.setValue(jogGroup, "jog", delta / 64.0);
    }
};

// jog_pb_a/b: Ch2/3 Pitch Bend (E1/E2) — touch-surface scratch
// Pitch bend range: 0x0000–0x3FFF–0x7FFF mapped to -1..0..+1
NS7III.jogPB = function(channel, control, value, status, group) {
    var side = (status === 0xE1) ? 0 : 1;
    var deck = NS7III.deckForSide(side);
    // value here is the combined 14-bit pitch bend, but Mixxx passes
    // it as 0-127 (MSB only in MIDI mapping). Use as nudge delta.
    var delta = value - 64;
    if (NS7III.scratchEnabled[side]) {
        engine.scratchTick(deck, delta * 0.5);
    } else {
        var jogGroup = "[Channel" + deck + "]";
        engine.setValue(jogGroup, "jog", delta / 64.0);
    }
};

// ── Init / shutdown ───────────────────────────────────────────────
NS7III.init = function(id, debugging) {
    // Light deck 1 and 2 selector LEDs (default layer state)
    midi.sendShortMsg(0x90, 2, 0x7F);  // led_deck_1
    midi.sendShortMsg(0x90, 3, 0x7F);  // led_deck_2
    midi.sendShortMsg(0x90, 4, 0x00);  // led_deck_3
    midi.sendShortMsg(0x90, 5, 0x00);  // led_deck_4
};

NS7III.shutdown = function(id) {
    // Stop both motors cleanly
    if (NS7III.motorRunning[0]) NS7III.motorStop(0);
    if (NS7III.motorRunning[1]) NS7III.motorStop(1);
    // Clear all LEDs
    for (var n = 2; n <= 5; n++)   midi.sendShortMsg(0x90, n, 0x00);
    for (var n = 51; n <= 53; n++) midi.sendShortMsg(0x91, n, 0x00);
    for (var n = 51; n <= 53; n++) midi.sendShortMsg(0x92, n, 0x00);
    for (var n = 61; n <= 68; n++) midi.sendShortMsg(0x91, n, 0x00);
    for (var n = 61; n <= 68; n++) midi.sendShortMsg(0x92, n, 0x00);
    for (var n = 71; n <= 80; n++) midi.sendShortMsg(0x91, n, 0x00);
    for (var n = 71; n <= 80; n++) midi.sendShortMsg(0x92, n, 0x00);
};

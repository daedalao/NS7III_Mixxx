// NumarkNS7III.js — ECMA-262 ES5 COMPLIANT
// RE-verified against Serato process memory dumps 2026-04-10.
//
// Channel layout:  Ch1 (0x90/0xB0) = mixer/global
//                  Ch2 (0x91/0xB1) = physical deck A (left)
//                  Ch3 (0x92/0xB2) = physical deck B (right)
//                  Ch4 (0x93/0xB3) = virtual layer deck A
//                  Ch5 (0x94/0xB4) = virtual layer deck B
//
// Motor protocol (per deck MIDI channel):
//   CC67=0  → ramped start    CC65=2  → instant start
//   CC66=3  → instant stop    CC68=1  → ramped stop
//   CC69    → RPM (0=33, 1=45)
//   CC70    → direction (0=fwd, 1=rev)
//   CC105   → PLL pitch correction output (sent by us to keep motor in sync)
//
// Platter: CC0 = 7-bit absolute wrapped position (128 pos/rev)
//          PitchWheel = 14-bit timestamp; touch detected via PLL slip (no note)
//
// Pitch fader: CC1 MSB + CC33 LSB → 14-bit, center=8192, deadzone ~0.1%
// SYNC=note50, SHIFT=note53, REVERSE=note63, SLIP=note68, CENSOR=note62
//
// Pitch takeover LEDs (output, per deck channel):
//   note62 = pitch_pickup_is_below_zero  (fader below target → move UP)
//   note63 = pitch_pickup_is_above_zero  (fader above target → move DOWN)
//   note64 = pitch_is_zero               (fader at center / matched)
//
// Channel VU meters: CC74–77 on Ch1 (0xB0) for decks 0–3.
// CC110 on deck channels = load_track reset only (send=0 on track load).
// BPM match meter: CC71 on Ch1 (0xB0). Center=64 = BPMs matched.
// Touch mode: Note13 on Ch1 (0x90) toggles EQ-kill-on-touch.

var NS7III = {};

// ─── Constants ───────────────────────────────────────────────────────────────

NS7III.MOTOR_CH   = [2, 3];   // MIDI channels for physical platters (1-indexed)
NS7III.RES        = 3600;     // scratch resolution (ticks per rev)
NS7III.PB_RATIO   = 1440;     // PitchBend ticks per platter tick at 1:1 speed

// VU meter CC numbers on Ch1 (0xB0), indexed by (deck - 1)
NS7III.VU_CC      = [74, 75, 76, 77];
NS7III.conns      = {}; // Store connections for re-triggering

NS7III.COL_OFF        = 0x00;
NS7III.COL_RED        = 0x01;
NS7III.COL_RED_DIM    = 0x02;
NS7III.COL_GREEN      = 0x10;
NS7III.COL_BLUE       = 0x30;
NS7III.COL_CYAN       = 0x25;
NS7III.COL_CYAN_DIM   = 0x20;
NS7III.COL_YELLOW     = 0x14;
NS7III.COL_YELLOW_DIM = 0x08;
NS7III.COL_WHITE      = 0x7F;

// ─── State ───────────────────────────────────────────────────────────────────

NS7III.motorRunning  = [false, false];
NS7III.leftDeck      = 1;
NS7III.rightDeck     = 2;
NS7III.padMode       = ["hotcue", "hotcue"];
NS7III.ROLL_SIZES    = ["0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8"];
NS7III.shiftHeld     = [false, false];
NS7III.blinkState    = false;
NS7III.blinkTimer    = 0;
NS7III.bpmTimer      = 0;

NS7III.jogLastCoarse     = [0, 0];
NS7III.jogLastDelta      = [0, 0];
NS7III.jogLastPB         = [8192, 8192];
NS7III.isTouching        = [false, false];
NS7III.releaseConfidence = [0, 0];
NS7III.lastSpinTime      = [0, 0];
NS7III.lastSentPLL       = [64, 64];  // last CC105 value sent (64 = neutral)
NS7III.lsbBEATS          = [0, 0];
NS7III.lsbPitch          = [0, 0];
NS7III.physicalRate      = [0.0, 0.0]; // last physical pitch fader value per side (normalised)
NS7III.inPickup          = [false, false]; // true when fader hasn't yet been picked up after deck switch
NS7III.platAlpha         = [1.0, 1.0];  // scratch alpha per side, tuned by CC12 stop_time
NS7III.handoffEnd        = [0, 0];      // timestamp to ignore platter after deck switch
NS7III.lsbXfader         = 0;
NS7III.censorActive      = [false, false];
NS7III.touchMode         = false;  // global touch-mode state (Note13 Ch1 toggle)
NS7III.lastSentBPMled    = -1;     // track last sent BPM meter value to avoid floods
NS7III.lastSentPos       = [-1, -1, -1, -1]; // track last sent playhead segment per deck (1-4)

// ─── Helpers ─────────────────────────────────────────────────────────────────

NS7III.deckForSide = function(side) {
    return side === 0 ? NS7III.leftDeck : NS7III.rightDeck;
};
NS7III._sideForDeck = function(deck) {
    return (deck === 1 || deck === 3) ? 0 : 1;
};

// ─── Motor Control ───────────────────────────────────────────────────────────
// Protocol confirmed from Serato RE. All motor CCs on deck MIDI channel.
// MOTOR_CH[side] is 1-indexed, so status = 0xB0 | (ch - 1).

NS7III.motorStart = function(side) {
    var deck = NS7III.deckForSide(side);
    // physical deck 1/2 = MIDI ch 2/3; virtual deck 3/4 = MIDI ch 4/5
    var ch  = (deck <= 2) ? NS7III.MOTOR_CH[side] : NS7III.MOTOR_CH[side] + 2;
    var st  = 0xB0 | (ch - 1);
    if (engine.isScratching(deck)) engine.scratchDisable(deck, false);

    var isReverse = engine.getValue("[Channel" + deck + "]", "reverse");
    midi.sendShortMsg(st, 69, 0);                    // CC69=0  → 33 RPM
    midi.sendShortMsg(st, 70, isReverse ? 1 : 0);   // CC70    → direction
    midi.sendShortMsg(st, 67, 0);                    // CC67=0  → ramped start
    NS7III.motorRunning[side] = true;
    // Immediately sync to current rate
    NS7III.syncPhysicalMotor(side, engine.getValue("[Channel" + deck + "]", "rate"));
};

NS7III.motorStop = function(side) {
    var deck = NS7III.deckForSide(side);
    var ch  = (deck <= 2) ? NS7III.MOTOR_CH[side] : NS7III.MOTOR_CH[side] + 2;
    var st = 0xB0 | (ch - 1);
    // Enable scratch with the platter's deceleration alpha so the playhead
    // follows the spinning-down platter instead of freezing.
    if (!engine.isScratching(deck)) {
        engine.scratchEnable(deck, NS7III.RES, 33.333,
            NS7III.platAlpha[side], NS7III.platAlpha[side] / 32.0, false);
    }
    midi.sendShortMsg(st, 68, 1);                    // CC68=1  → ramped stop
    NS7III.motorRunning[side] = false;
    NS7III.lastSentPLL[side] = 64;
    // Scratch will auto-disable once the platter stops sending ticks.
};

// CC105 = platter_motorized_pitch_output (PLL correction).
// Serato confirmed: this is the only rate control when motor is running.
// Value 64 = neutral/1× speed.  <64 = slower, >64 = faster.
NS7III.syncPhysicalMotor = function(side, rate) {
    if (!NS7III.motorRunning[side]) return;
    var deck = NS7III.deckForSide(side);
    var ch  = (deck <= 2) ? NS7III.MOTOR_CH[side] : NS7III.MOTOR_CH[side] + 2;
    var st   = 0xB0 | (ch - 1);
    var isReverse = engine.getValue("[Channel" + deck + "]", "reverse");
    var rateRange = engine.getValue("[Channel" + deck + "]", "rateRange");

    var effectiveRate = rate * rateRange;
    var pll = Math.round(64 + (effectiveRate * 64));
    pll = Math.max(1, Math.min(127, pll));

    if (pll !== NS7III.lastSentPLL[side]) {
        midi.sendShortMsg(st, 105, pll);
        NS7III.lastSentPLL[side] = pll;
    }

    midi.sendShortMsg(st, 70, isReverse ? 1 : 0);
};

NS7III._onPlayChange = function(v, g) {
    var match = g.match(/\d+/);
    if (!match) return;
    var d = parseInt(match[0], 10);
    var s = NS7III._sideForDeck(d);
    // Only drive motor if this deck is the currently selected one for this side.
    if (NS7III.deckForSide(s) !== d) return;
    if (v > 0) {
        if (!NS7III.motorRunning[s]) NS7III.motorStart(s);
    } else {
        if (NS7III.motorRunning[s]) NS7III.motorStop(s);
    }
};

// ─── Platter / Jog ───────────────────────────────────────────────────────────

// CC0: absolute 7-bit wrapped platter position (128 steps/rev)
NS7III.jogSpin = function(c, n, v, s) {
    var side = ((s & 0x0F) - 1) % 2;
    if (side < 0 || side > 1) return;
    var deck = NS7III.deckForSide(side);

    var now = new Date().getTime();
    if (now < NS7III.handoffEnd[side]) return;

    var delta = v - NS7III.jogLastCoarse[side];
    if (delta > 64) delta -= 128; else if (delta < -64) delta += 128;

    // Suppress micro-jitter while platter is holding position
    NS7III.jogLastDelta[side] = (NS7III.isTouching[side] && Math.abs(delta) < 2) ? 0 : delta;
    NS7III.lastSpinTime[side] = new Date().getTime();

    if (NS7III.isTouching[side] || !NS7III.motorRunning[side]) {
        engine.scratchTick(deck, NS7III.jogLastDelta[side]);
    }
    NS7III.jogLastCoarse[side] = v;
};

// PitchWheel: 14-bit timestamp used as PLL slip detector.
NS7III.jogPB = function(c, n, v, s) {
    var side = ((s & 0x0F) - 1) % 2;
    if (side < 0 || side > 1) return;
    var deck = NS7III.deckForSide(side);

    var now = new Date().getTime();
    if (now < NS7III.handoffEnd[side]) return;

    var currentPB = (v << 7) | n;
    var deltaPB = currentPB - NS7III.jogLastPB[side];
    if (deltaPB > 8192) deltaPB -= 16384; else if (deltaPB < -8192) deltaPB += 16384;

    var now = new Date().getTime();
    var effectiveDelta = (now - NS7III.lastSpinTime[side] > 30) ? 0 : NS7III.jogLastDelta[side];
    var slipError = Math.abs(deltaPB - (effectiveDelta * NS7III.PB_RATIO));

    if (slipError > 900) {
        // Hand faster/slower than motor → user is touching platter
        NS7III.releaseConfidence[side] = 0;
        if (!NS7III.isTouching[side]) {
            engine.scratchEnable(deck, NS7III.RES, 33.333,
                NS7III.platAlpha[side], NS7III.platAlpha[side] / 32.0, false);
            NS7III.isTouching[side] = true;
        }
    } else {
        // Motor and hand agree → confirm release after 8 consecutive packets
        if (NS7III.isTouching[side]) {
            NS7III.releaseConfidence[side]++;
            if (NS7III.releaseConfidence[side] >= 8) {
                NS7III.isTouching[side] = false;
                NS7III.releaseConfidence[side] = 0;
                if (NS7III.motorRunning[side]) {
                    engine.scratchDisable(deck, true);
                }
            }
        }
    }
    NS7III.jogLastPB[side] = currentPB;
};

// ─── Transport ────────────────────────────────────────────────────────────────

NS7III.play = function(c, n, v) {
    if (v === 0) return;
    var side = (c % 2 === 0 ? 1 : 0);
    var d = NS7III.deckForSide(side);
    engine.setValue("[Channel" + d + "]", "play", !engine.getValue("[Channel" + d + "]", "play"));
};
NS7III.cue = function(c, n, v) {
    var side = (c % 2 === 0 ? 1 : 0);
    var d = NS7III.deckForSide(side);
    engine.setValue("[Channel" + d + "]", "cue_default", v > 0 ? 1 : 0);
};
NS7III.sync = function(c, n, v) {
    if (v === 0) return;
    var side = (c % 2 === 0 ? 1 : 0);
    var d = NS7III.deckForSide(side);
    engine.setValue("[Channel" + d + "]", "sync_enabled", !engine.getValue("[Channel" + d + "]", "sync_enabled"));
};
NS7III.shift = function(c, n, v) {
    NS7III.shiftHeld[c % 2 === 0 ? 1 : 0] = (v > 0);
};
NS7III.load = function(c, n, v) {
    if (v === 0) return;
    var side = (c % 2 === 0 ? 1 : 0);
    var d = NS7III.deckForSide(side);
    engine.setValue("[Channel" + d + "]", "LoadSelectedTrack", 1);
};

NS7III.reverse = function(c, n, v, s) {
    var side = (c % 2 === 0 ? 1 : 0);
    var d    = NS7III.deckForSide(side);
    var g    = "[Channel" + d + "]";
    var rel  = (s & 0xF0) === 0x80 || v === 0;
    engine.setValue(g, "reverse", rel ? 0 : 1);
    NS7III.syncPhysicalMotor(side, engine.getValue(g, "rate"));
};

NS7III.censor = function(c, n, v, s) {
    var side  = (c % 2 === 0 ? 1 : 0);
    var d     = NS7III.deckForSide(side);
    var g     = "[Channel" + d + "]";
    var press = (s & 0xF0) === 0x90 && v > 0;
    if (press) {
        NS7III.censorActive[side] = true;
        engine.setValue(g, "slip_enabled", 1);
        engine.setValue(g, "reverse", 1);
        NS7III.syncPhysicalMotor(side, engine.getValue(g, "rate"));
    } else if (NS7III.censorActive[side]) {
        NS7III.censorActive[side] = false;
        engine.setValue(g, "reverse", 0);
        engine.setValue(g, "slip_enabled", 0);
        NS7III.syncPhysicalMotor(side, engine.getValue(g, "rate"));
    }
};

NS7III.slip = function(c, n, v) {
    if (v === 0) return;
    var side = (c % 2 === 0 ? 1 : 0);
    if (NS7III.shiftHeld[side]) {
        if (NS7III.motorRunning[side]) NS7III.motorStop(side);
        else NS7III.motorStart(side);
    } else {
        var d = NS7III.deckForSide(side);
        engine.setValue("[Channel" + d + "]", "slip_enabled", !engine.getValue("[Channel" + d + "]", "slip_enabled"));
    }
};

NS7III.nudgeFwd = function(c, n, v, s) {
    var side = (c % 2 === 0 ? 1 : 0);
    var d = NS7III.deckForSide(side);
    engine.setValue("[Channel" + d + "]", "rate_temp_up", (s & 0xF0) === 0x90 && v > 0 ? 1 : 0);
};
NS7III.nudgeBack = function(c, n, v, s) {
    var side = (c % 2 === 0 ? 1 : 0);
    var d = NS7III.deckForSide(side);
    engine.setValue("[Channel" + d + "]", "rate_temp_down", (s & 0xF0) === 0x90 && v > 0 ? 1 : 0);
};

// ─── Pitch Controls ──────────────────────────────────────────────────────────

NS7III.pitch = function(channel, control, value, status, group) {
    var side    = ((status & 0x0F) - 1) % 2;
    var fullVal = (value << 7) | NS7III.lsbPitch[side];
    var norm    = (8192.0 - fullVal) / 8192.0;
    if (Math.abs(norm) < 0.001) norm = 0;

    NS7III.physicalRate[side] = norm;

    var deck = NS7III.deckForSide(side);
    var g    = "[Channel" + deck + "]";
    var swRate = engine.getValue(g, "rate");

    if (NS7III.inPickup[side]) {
        if (Math.abs(norm - swRate) < 0.005) {
            NS7III.inPickup[side] = false;
            engine.setValue(g, "rate", norm);
            NS7III.syncPhysicalMotor(side, norm);
            NS7III._updatePitchLeds(side, norm, norm);
        } else {
            NS7III._updatePitchLeds(side, norm, swRate);
        }
    } else {
        engine.setValue(g, "rate", norm);
        NS7III.syncPhysicalMotor(side, norm);
        NS7III._updatePitchLeds(side, norm, norm);
    }
};

NS7III.pitchLSB = function(channel, control, value, status) {
    var side = ((status & 0x0F) - 1) % 2;
    NS7III.lsbPitch[side] = value;
};

NS7III._updatePitchLeds = function(side, physRate, swRate) {
    var deck = NS7III.deckForSide(side);
    var st = 0x90 + deck;
    var DEAD = 0.005;
    var diff = physRate - swRate;
    if (Math.abs(diff) <= DEAD) {
        midi.sendShortMsg(st, 62, 0x00);
        midi.sendShortMsg(st, 63, 0x00);
        midi.sendShortMsg(st, 64, Math.abs(physRate) < 0.001 ? 0x7F : 0x00);
    } else if (diff < -DEAD) {
        midi.sendShortMsg(st, 62, 0x00);
        midi.sendShortMsg(st, 63, 0x7F);
        midi.sendShortMsg(st, 64, 0x00);
    } else {
        midi.sendShortMsg(st, 62, 0x7F);
        midi.sendShortMsg(st, 63, 0x00);
        midi.sendShortMsg(st, 64, 0x00);
    }
};

NS7III.pitchRange = function(channel, control, value, status, group) {
    if (value === 0) return;
    var ranges = [0.08, 0.16, 0.50];
    var current = engine.getValue(group, "rateRange");
    var nextIndex = 0;
    for (var i = 0; i < ranges.length; i++) {
        if (Math.abs(current - ranges[i]) < 0.01) { nextIndex = (i + 1) % ranges.length; break; }
    }
    engine.setValue(group, "rateRange", ranges[nextIndex]);
};

NS7III.tapTempo = function(channel, control, value, status, group) {
    if (value > 0) engine.setValue(group, "bpm_tap", 1);
};

NS7III.gridAdjust = function(channel, control, value, status, group) {
    if (value > 0) engine.setValue(group, "beats_adjust", 1);
};

NS7III.gridSlip = function(channel, control, value, status, group) {
    if (value === 0) return;
    var side = NS7III._sideForDeck(channel);
    engine.setValue(group, NS7III.shiftHeld[side] ? "beats_translate_earlier" : "beats_translate_later", 1);
};

// ─── Crossfader ──────────────────────────────────────────────────────────────

NS7III.crossfaderLSB = function(channel, control, value) {
    NS7III.lsbXfader = value;
};
NS7III.crossfaderMSB = function(channel, control, value) {
    var full = (value << 7) | NS7III.lsbXfader;
    engine.setValue("[Master]", "crossfader", (full / 8191.5) - 1.0);
};

NS7III.crossfaderCurve = function(channel, control, value) {
    engine.setValue("[Mixer Profile]", "xFaderMode", value > 64 ? 0 : 1);
};

NS7III.xfaderAssignLeft = function(channel, control, value, status, group) {
    if (value > 0) engine.setValue(group, "orientation", 0);
};
NS7III.xfaderAssignRight = function(channel, control, value, status, group) {
    if (value > 0) engine.setValue(group, "orientation", 2);
};

// ─── EQ Kills ────────────────────────────────────────────────────────────────

NS7III.eqKillLow = function(channel, control, value, status, group) {
    if (value > 0) {
        var eqG = "[EqualizerRack1_" + group + "_Effect1]";
        engine.setValue(eqG, "button_parameter1", !engine.getValue(eqG, "button_parameter1"));
    }
};
NS7III.eqKillMid = function(channel, control, value, status, group) {
    if (value > 0) {
        var eqG = "[EqualizerRack1_" + group + "_Effect1]";
        engine.setValue(eqG, "button_parameter2", !engine.getValue(eqG, "button_parameter2"));
    }
};
NS7III.eqKillHigh = function(channel, control, value, status, group) {
    if (value > 0) {
        var eqG = "[EqualizerRack1_" + group + "_Effect1]";
        engine.setValue(eqG, "button_parameter3", !engine.getValue(eqG, "button_parameter3"));
    }
};

// ─── Touch Mode (Note13 Ch1) ─────────────────────────────────────────────────

NS7III.touchModeBtn = function(channel, control, value) {
    if (value === 0) return;
    NS7III.touchMode = !NS7III.touchMode;
    midi.sendShortMsg(0x90, 13, NS7III.touchMode ? 0x7F : 0x00);
};

NS7III.eqTouchLo = function(c, n, v, s, g) { NS7III._eqTouchHandler(g, "lo", v > 0); };
NS7III.eqTouchMid = function(c, n, v, s, g) { NS7III._eqTouchHandler(g, "mid", v > 0); };
NS7III.eqTouchHi = function(c, n, v, s, g) { NS7III._eqTouchHandler(g, "hi", v > 0); };

NS7III._eqTouchHandler = function(group, band, isPress) {
    if (!NS7III.touchMode) return;
    var eqG = "[EqualizerRack1_" + group + "_Effect1]";
    var key = (band === "hi") ? "button_parameter3" :
              (band === "mid") ? "button_parameter2" : "button_parameter1";
    engine.setValue(eqG, key, isPress ? 1 : 0);
};

// ─── Filter Roll Touch ───────────────────────────────────────────────────────

NS7III.filterRollTouch = function(channel, control, value, status, group) {
    var press = (status & 0xF0) === 0x90 && value > 0;
    var chanNum = group.replace(/[^0-9]/g, "");
    engine.setValue("[QuickEffectRack1_Channel" + chanNum + "]", "enabled", press ? 1 : 0);
};

// ─── Filter Roll Knob ────────────────────────────────────────────────────────

NS7III.lsbFilterRoll = [0, 0, 0, 0];
NS7III.filterRollKnob = function(channel, control, value, status, group) {
    var chanNum = parseInt(group.replace(/[^0-9]/g, ""), 10);
    var full = (value << 7) | NS7III.lsbFilterRoll[chanNum - 1];
    engine.setValue("[QuickEffectRack1_Channel" + chanNum + "]", "super1", full / 16383.0);
};

NS7III.filterRollKnobLSB = function(channel, control, value, status, group) {
    var chanNum = parseInt(group.replace(/[^0-9]/g, ""), 10);
    NS7III.lsbFilterRoll[chanNum - 1] = value;
};

// ─── FX ──────────────────────────────────────────────────────────────────────

NS7III.fxEncoder = function(channel, control, value, status, group) {
    engine.setValue(group, "meta", value / 127.0);
    midi.sendShortMsg(status & 0xF0 | (status & 0x0F), control, value);
};

NS7III.fxWet = function(channel, control, value, status, group) {
    engine.setValue(group, "super1", value / 127.0);
};

NS7III.fxBeatsMSB = function(channel, control, value, status, group) {
    var side = (control === 24) ? 0 : 1;
    var fullVal = (value << 7) | NS7III.lsbBEATS[side];
    engine.setValue(group, "mix", fullVal / 16383.0);
};
NS7III.fxBeatsLSB = function(channel, control, value, status, group) {
    var side = (control === 56 || control === 107) ? (control === 56 ? 0 : 1) : 0;
    NS7III.lsbBEATS[side] = value;
};

NS7III.fxBtn = function(channel, control, value, status, group) {
    if (value === 0) return;
    var enabled = !engine.getValue(group, "enabled");
    engine.setValue(group, "enabled", enabled);
    midi.sendShortMsg(status & 0xF0 | (status & 0x0F), control, enabled ? 0x7F : 0x00);
};

NS7III.fxTapTempo = function(channel, control, value, status, group) {
    if (value > 0) engine.setValue(group, "tap_tempo", 1);
};

NS7III.fxBankMode = function(channel, control, value, status, group) {
    if (value === 0) return;
    var note = control;
    var unitNum, side;
    if      (note === 100) { unitNum = 1; side = 0; }
    else if (note === 101) { unitNum = 2; side = 0; }
    else if (note === 102) { unitNum = 3; side = 0; }
    else if (note === 104) { unitNum = 1; side = 1; }
    else if (note === 105) { unitNum = 2; side = 1; }
    else if (note === 106) { unitNum = 3; side = 1; }
    else return;

    var deck = NS7III.deckForSide(side);
    var chanGroup = "[Channel" + deck + "]";
    var fxGroup = "[EffectRack1_EffectUnit" + unitNum + "]";
    var key = "group_" + chanGroup + "_enable";
    var enabled = !engine.getValue(fxGroup, key);
    engine.setValue(fxGroup, key, enabled);
    midi.sendShortMsg(0x90, note, enabled ? 0x7F : 0x00);
};

NS7III.fxUnit1Ch1Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit1]", "[Channel1]"); };
NS7III.fxUnit1Ch2Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit1]", "[Channel2]"); };
NS7III.fxUnit1Ch3Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit1]", "[Channel3]"); };
NS7III.fxUnit1Ch4Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit1]", "[Channel4]"); };
NS7III.fxUnit2Ch1Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit2]", "[Channel1]"); };
NS7III.fxUnit2Ch2Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit2]", "[Channel2]"); };
NS7III.fxUnit2Ch3Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit2]", "[Channel3]"); };
NS7III.fxUnit2Ch4Assign = function(c, n, v) { if (v > 0) NS7III._fxToggle("[EffectRack1_EffectUnit2]", "[Channel4]"); };

NS7III._fxToggle = function(fxGroup, chanGroup) {
    var key = "group_" + chanGroup + "_enable";
    engine.setValue(fxGroup, key, !engine.getValue(fxGroup, key));
};

NS7III.fxMasterAssign = function(c, n, v, s, group) {
    if (v > 0) NS7III._fxToggle(group, "[Master]");
};
NS7III.fxHeadphoneAssign = function(c, n, v, s, group) {
    if (v > 0) NS7III._fxToggle(group, "[Headphone]");
};

// ─── BPM Match Meter & Timer ─────────────────────────────────────────────────

NS7III._updateBpmMeter = function() {
    // 1. Playhead Tracking (15-LED Needle Search strip)
    [0, 1].forEach(function(side) {
        var deck = NS7III.deckForSide(side);
        var pos = engine.getValue("[Channel" + deck + "]", "playposition");
        if (pos === undefined || pos < 0) return;

        // Map 0.0-1.0 to 15 discrete segments (0-15).
        // Sending raw segment index (0-15) instead of 0-127.
        var segment = Math.floor(pos * 15.0);
        segment = Math.max(0, Math.min(15, segment));
        
        if (segment !== NS7III.lastSentPos[deck - 1]) {
            midi.sendShortMsg(0xB0 | deck, 110, segment);
            NS7III.lastSentPos[deck - 1] = segment;
        }
    });

    // 2. Master VU Meter (CC 78/79 Ch 1) - Apply life curve
    var masterL = engine.getValue("[Master]", "vu_meter_left");
    var masterR = engine.getValue("[Master]", "vu_meter_right");
    midi.sendShortMsg(0xB0, 78, Math.round(Math.sqrt(masterL) * 127));
    midi.sendShortMsg(0xB0, 79, Math.round(Math.sqrt(masterR) * 127));

    // 3. BPM Balance Meter (11 LEDs, CC 71 Ch 1)
    var dA = NS7III.leftDeck;
    var dB = NS7III.rightDeck;
    var gA = "[Channel" + dA + "]";
    var gB = "[Channel" + dB + "]";
    var bpmA = engine.getValue(gA, "bpm") * (1 + engine.getValue(gA, "rate") * engine.getValue(gA, "rateRange"));
    var bpmB = engine.getValue(gB, "bpm") * (1 + engine.getValue(gB, "rate") * engine.getValue(gB, "rateRange"));

    var ledVal;
    if (bpmA > 0 && bpmB > 0) {
        var ratio = bpmB / bpmA;
        // Sensitivity: ±5% diff covers 11 LEDs (5 is center).
        // Sending raw LED index (0-10) instead of 0-127.
        var ledIndex = 5 + Math.round((ratio - 1.0) * 100); 
        ledVal = Math.max(0, Math.min(10, ledIndex));
    } else {
        ledVal = 5; // Exact center index
    }

    if (ledVal !== NS7III.lastSentBPMled) {
        midi.sendShortMsg(0xB0, 71, ledVal);
        NS7III.lastSentBPMled = ledVal;
    }
};

// ─── Auto-Loop Roll ───────────────────────────────────────────────────────────

NS7III.autoLoopRoll = function(channel, control, value) {
    if (value === 0) return;
    var g = "[Channel" + NS7III.leftDeck + "]";
    var active = engine.getValue(g, "loop_enabled");
    engine.setValue(g, active ? "beatlooproll_activate" : "beatloop_1_toggle", 1);
};

// ─── Pads ─────────────────────────────────────────────────────────────────────

NS7III.pad = function(c, n, v, status) {
    var side = NS7III._sideForDeck(c);
    var p    = n - 70;
    var g    = "[Channel" + NS7III.deckForSide(side) + "]";
    var isRelease = (status & 0xF0) === 0x80 || ((status & 0xF0) === 0x90 && v === 0);

    if (NS7III.padMode[side] === "hotcue") {
        if (!isRelease) engine.setValue(g, "hotcue_" + p + "_" + (NS7III.shiftHeld[side] ? "clear" : "activate"), 1);
    } else if (NS7III.padMode[side] === "autoloop") {
        if (!isRelease) engine.setValue(g, "beatloop_" + NS7III.ROLL_SIZES[p - 1] + "_toggle", 1);
    } else if (NS7III.padMode[side] === "roll") {
        if (!isRelease) engine.setValue(g, "beatlooproll_" + NS7III.ROLL_SIZES[p - 1] + "_activate", 1);
        else engine.setValue(g, "loop_enabled", 0);
    } else if (NS7III.padMode[side] === "manualloop") {
        if (!isRelease) {
            if (p === 1) engine.setValue(g, "loop_in", 1);
            else if (p === 2) engine.setValue(g, "loop_out", 1);
            else if (p === 3) engine.setValue(g, "loop_halve", 1);
            else if (p === 4) engine.setValue(g, "loop_double", 1);
            else if (p === 5) engine.setValue(g, "reloop_toggle", 1);
        }
    } else if (NS7III.padMode[side] === "sampler") {
        var sg = "[Sampler" + p + "]";
        if (!isRelease) engine.setValue(sg, "cue_goto_and_play", 1);
        else engine.setValue(sg, "play", 0);
    } else if (NS7III.padMode[side] === "beatjump") {
        var beatJumpSizes = [-1, -2, -4, -8, 1, 2, 4, 8];
        if (!isRelease) engine.setValue(g, "beatjump", beatJumpSizes[p - 1]);
    }
};

NS7III.padModeCues = function(c, n, v) {
    if (v === 0) return;
    var s = NS7III._sideForDeck(c);
    NS7III.padMode[s] = "hotcue";
    NS7III._updatePadModeLeds(s);
    NS7III._refreshPadColors(s);
};
NS7III.padModeAutoRoll = function(c, n, v) {
    if (v === 0) return;
    var s = NS7III._sideForDeck(c);
    NS7III.padMode[s] = (NS7III.padMode[s] === "autoloop") ? "roll" : "autoloop";
    NS7III._updatePadModeLeds(s);
    NS7III._refreshPadColors(s);
};
NS7III.padModeManual = function(c, n, v) {
    if (v === 0) return;
    var s = NS7III._sideForDeck(c);
    NS7III.padMode[s] = "manualloop";
    NS7III._updatePadModeLeds(s);
    NS7III._refreshPadColors(s);
};
NS7III.padModeSampler = function(c, n, v) {
    if (v === 0) return;
    var s = NS7III._sideForDeck(c);
    NS7III.padMode[s] = "sampler";
    NS7III._updatePadModeLeds(s);
    NS7III._refreshPadColors(s);
};
NS7III.padModeBeatjump = function(c, n, v) {
    if (v === 0) return;
    var s = NS7III._sideForDeck(c);
    NS7III.padMode[s] = "beatjump";
    NS7III._updatePadModeLeds(s);
    NS7III._refreshPadColors(s);
};

NS7III.paramLeft  = function(c, n, v) { if (v > 0) { var g = "[Channel" + NS7III.deckForSide(NS7III._sideForDeck(c)) + "]"; engine.setValue(g, "loop_halve",  1); } };
NS7III.paramRight = function(c, n, v) { if (v > 0) { var g = "[Channel" + NS7III.deckForSide(NS7III._sideForDeck(c)) + "]"; engine.setValue(g, "loop_double", 1); } };

NS7III.hotCue = function(c, n, v, s, group) {
    if (v === 0) return;
    var cueNum = n - 53;
    var side = NS7III._sideForDeck(c);
    engine.setValue(group, NS7III.shiftHeld[side] ? "hotcue_" + cueNum + "_clear" : "hotcue_" + cueNum + "_activate", 1);
};

// ─── Navigation ──────────────────────────────────────────────────────────────

NS7III.libraryScroll = function(c, n, v) {
    engine.setValue("[Library]", "MoveVertical", (v === 1) ? -1 : 1);
};
NS7III.needleSearch = function(c, n, v, s) {
    var side = ((s & 0x0F) - 1) % 2;
    engine.setValue("[Channel" + NS7III.deckForSide(side) + "]", "playposition", v / 127.0);
};

// ─── Platter Timing ──────────────────────────────────────────────────────────

NS7III.platterStopTime = function(c, n, v, s) {
    var side = ((s & 0x0F) - 1) % 2;
    NS7III.platAlpha[side] = Math.max(0.1, 1.0 - (v / 141.0));
};

NS7III.platterStartTime = function(c, n, v, s) {};

// ─── Deck Selection ──────────────────────────────────────────────────────────

NS7III.deckSel1 = function(c, n, v) { if (v > 0) { NS7III.leftDeck  = 1; NS7III._updateDeckLeds(); NS7III._deckSelUpdate(0); } };
NS7III.deckSel2 = function(c, n, v) { if (v > 0) { NS7III.rightDeck = 2; NS7III._updateDeckLeds(); NS7III._deckSelUpdate(1); } };
NS7III.deckSel3 = function(c, n, v) { if (v > 0) { NS7III.leftDeck  = 3; NS7III._updateDeckLeds(); NS7III._deckSelUpdate(0); } };
NS7III.deckSel4 = function(c, n, v) { if (v > 0) { NS7III.rightDeck = 4; NS7III._updateDeckLeds(); NS7III._deckSelUpdate(1); } };

NS7III._deckSelUpdate = function(side) {
    NS7III.inPickup[side] = true;
    NS7III.handoffEnd[side] = new Date().getTime() + 100; // 100ms deadzone
    var deck   = NS7III.deckForSide(side);
    var g      = "[Channel" + deck + "]";
    var swRate = engine.getValue(g, "rate");

    NS7III._updatePitchLeds(side, NS7III.physicalRate[side], swRate);
    NS7III._updatePadModeLeds(side);
    NS7III._refreshPadColors(side);
    NS7III._refreshAllLeds(side);
    NS7III._updateDeckLeds();

    // Explicitly hand-off motor state to newly selected deck
    NS7III._onPlayChange(engine.getValue(g, "play"), g);
};
NS7III._refreshAllLeds = function(side) {
    var deck = NS7III.deckForSide(side);
    var g = "[Channel" + deck + "]";
    
    // Force immediate playhead update for the newly selected deck
    var pos = engine.getValue(g, "playposition");
    if (pos !== undefined && pos >= 0) {
        var midiVal = Math.floor(pos * 127);
        midiVal = Math.max(0, Math.min(126, midiVal));
        midi.sendShortMsg(0xB0 | deck, 110, midiVal);
        NS7III.lastSentPos[deck - 1] = midiVal;
    }

    for (var key in NS7III.conns) {
        if (key.indexOf(g) === 0) NS7III.conns[key].trigger();
    }
    NS7III.syncPhysicalMotor(side, engine.getValue(g, "rate"));
};

NS7III._updateDeckLeds = function() {
    midi.sendShortMsg(0x90, 2, NS7III.leftDeck  === 1 ? 0x7F : 0x00);
    midi.sendShortMsg(0x90, 4, NS7III.leftDeck  === 3 ? 0x7F : 0x00);
    midi.sendShortMsg(0x90, 3, NS7III.rightDeck === 2 ? 0x7F : 0x00);
    midi.sendShortMsg(0x90, 5, NS7III.rightDeck === 4 ? 0x7F : 0x00);
};

// ─── LED Helpers ─────────────────────────────────────────────────────────────

NS7III._onBlinkTick = function() {
    NS7III.blinkState = !NS7III.blinkState;
    NS7III._refreshPadColors(0);
    NS7III._refreshPadColors(1);
};

NS7III._updatePadModeLeds = function(side) {
    var deck = NS7III.deckForSide(side);
    var s    = 0x90 + deck;
    var mode = NS7III.padMode[side];
    midi.sendShortMsg(s, 79, mode === "hotcue" ? NS7III.COL_GREEN : NS7III.COL_OFF);
    midi.sendShortMsg(s, 80, (mode === "autoloop" || mode === "roll") ? NS7III.COL_BLUE : NS7III.COL_OFF);
    midi.sendShortMsg(s, 81, mode === "manualloop" ? NS7III.COL_YELLOW : NS7III.COL_OFF);
    midi.sendShortMsg(s, 82, mode === "sampler" ? NS7III.COL_RED : NS7III.COL_OFF);
    midi.sendShortMsg(s, 83, mode === "beatjump" ? NS7III.COL_CYAN : NS7III.COL_OFF);
};

NS7III._refreshPadColors = function(side) {
    var deck = NS7III.deckForSide(side);
    var s    = 0x90 + deck;
    var g    = "[Channel" + deck + "]";
    var mode = NS7III.padMode[side];
    for (var i = 1; i <= 8; i++) {
        var color = NS7III.COL_OFF;
        if (mode === "hotcue") {
            color = engine.getValue(g, "hotcue_" + i + "_status") ? NS7III.COL_GREEN : NS7III.COL_OFF;
        } else if (mode === "autoloop") {
            var al = engine.getValue(g, "beatloop_" + NS7III.ROLL_SIZES[i - 1] + "_enabled");
            color  = al ? (NS7III.blinkState ? NS7III.COL_WHITE : NS7III.COL_BLUE) : NS7III.COL_CYAN_DIM;
        } else if (mode === "roll") {
            var rl = engine.getValue(g, "beatloop_" + NS7III.ROLL_SIZES[i - 1] + "_enabled");
            color  = rl ? NS7III.COL_WHITE : NS7III.COL_RED_DIM;
        } else if (mode === "manualloop") {
            if (i === 1) color = engine.getValue(g, "loop_in") ? NS7III.COL_WHITE : NS7III.COL_YELLOW_DIM;
            else if (i === 2) color = engine.getValue(g, "loop_out") ? NS7III.COL_WHITE : NS7III.COL_YELLOW_DIM;
            else if (i === 5) color = engine.getValue(g, "loop_enabled") ? (NS7III.blinkState ? NS7III.COL_WHITE : NS7III.COL_YELLOW) : NS7III.COL_OFF;
            else if (i <= 4) color = NS7III.COL_YELLOW_DIM;
        } else if (mode === "sampler") {
            color = engine.getValue("[Sampler" + i + "]", "play_indicator") ? NS7III.COL_RED : NS7III.COL_RED_DIM;
        } else if (mode === "beatjump") {
            color = i <= 4 ? NS7III.COL_CYAN_DIM : NS7III.COL_CYAN;
        }
        midi.sendShortMsg(s, 70 + i, color);
    }
};

// ─── Per-deck engine connections ─────────────────────────────────────────────

NS7III._connectLedsForDeck = function(deck, side) {
    var g = "[Channel" + deck + "]";
    var s = 0x90 + deck;
    if (engine.getValue(g, "play") === undefined) return;

    var indicators = [[52, "play_indicator"], [51, "cue_indicator"], [50, "sync_enabled"], [68, "slip_enabled"], [63, "reverse"]];
    indicators.forEach(function(m) {
        NS7III.conns[g + "_" + m[1]] = engine.makeConnection(g, m[1], function(v) {
            if (NS7III.deckForSide(side) !== deck) return;
            midi.sendShortMsg(s, m[0], v ? 0x7F : 0x00);
        });
        NS7III.conns[g + "_" + m[1]].trigger();
    });

    for (var i = 1; i <= 8; i++) {
        (function(n) {
            var c1 = engine.makeConnection(g, "hotcue_" + n + "_status", function() {
                if (NS7III.deckForSide(side) === deck && NS7III.padMode[side] === "hotcue") NS7III._refreshPadColors(side);
            });
            if (c1) c1.trigger();
            var c2 = engine.makeConnection(g, "beatloop_" + NS7III.ROLL_SIZES[n - 1] + "_enabled", function() {
                if (NS7III.deckForSide(side) === deck && (NS7III.padMode[side] === "autoloop" || NS7III.padMode[side] === "roll")) NS7III._refreshPadColors(side);
            });
            if (c2) c2.trigger();
        })(i);
    }

    var cL = engine.makeConnection(g, "loop_enabled", function() {
        if (NS7III.deckForSide(side) === deck && NS7III.padMode[side] === "manualloop") NS7III._refreshPadColors(side);
    });
    if (cL) cL.trigger();

    engine.makeConnection(g, "rate",    function(v) { NS7III.syncPhysicalMotor(side, v); });
    engine.makeConnection(g, "reverse", function()  { NS7III.syncPhysicalMotor(side, engine.getValue(g, "rate")); });
    engine.makeConnection(g, "play",    NS7III._onPlayChange);

    engine.makeConnection(g, "rate", function(v) {
        if (NS7III.deckForSide(side) === deck) NS7III._updatePitchLeds(side, NS7III.physicalRate[side], v);
    });

    for (var hc = 1; hc <= 5; hc++) {
        (function(n) {
            var conn = engine.makeConnection(g, "hotcue_" + n + "_status", function(v) {
                midi.sendShortMsg(s, 53 + n, v ? 0x7F : 0x00);
            });
            if (conn) conn.trigger();
        })(hc);
    }

    midi.sendShortMsg(s, 59, 0x7F);
    midi.sendShortMsg(s, 60, 0x7F);

    // Channel VU meter: 11 physical segments. 
    // Store in NS7III.conns to prevent garbage collection.
    NS7III.conns[g + "_vu_meter"] = engine.makeConnection(g, "vu_meter", function(v) {
        // Post-fader VU meter: scale by channel volume and use linear 0-11 range
        var vol = engine.getValue(g, "volume");
        var scaled = Math.round(v * vol * 11);
        // Only send to Global channel (B0) as per Serato spec
        midi.sendShortMsg(0xB0, NS7III.VU_CC[deck - 1], scaled);
    });
    NS7III.conns[g + "_vu_meter"].trigger();

    var ccCh = 0xB0 | deck;
    NS7III.conns[g + "_track_loaded"] = engine.makeConnection(g, "track_loaded", function(v) { 
        if (v) midi.sendShortMsg(ccCh, 110, 0); 
    });
};

// ─── Init / Shutdown ─────────────────────────────────────────────────────────

NS7III.init = function() {
    midi.sendShortMsg(0xB0, 71, 0);
    midi.sendShortMsg(0xB0, 74, 0);
    midi.sendShortMsg(0xB0, 75, 0);

    for (var fa = 35; fa <= 44; fa++) midi.sendShortMsg(0x90, fa, 0x00);

    for (var fe = 15; fe <= 17; fe++) {
        midi.sendShortMsg(0x91, fe, 0x00);
        midi.sendShortMsg(0x92, fe + 4, 0x00);
    }

    midi.sendShortMsg(0x91, 62, 0x00); midi.sendShortMsg(0x91, 63, 0x00); midi.sendShortMsg(0x91, 64, 0x7F);
    midi.sendShortMsg(0x92, 62, 0x00); midi.sendShortMsg(0x92, 63, 0x00); midi.sendShortMsg(0x92, 64, 0x7F);

    midi.sendShortMsg(0x90, 13, 0x00);

    for (var d = 1; d <= 4; d++) NS7III._connectLedsForDeck(d, NS7III._sideForDeck(d));

    NS7III._updatePadModeLeds(0);
    NS7III._updatePadModeLeds(1);
    NS7III._updateDeckLeds();

    NS7III.blinkTimer = engine.beginTimer(500, NS7III._onBlinkTick);
    NS7III.bpmTimer = engine.beginTimer(200, NS7III._updateBpmMeter);

    midi.sendShortMsg(0xB0, 71, 64);
    NS7III.lastSentBPMled = 64;
};

NS7III.shutdown = function() {
    if (NS7III.blinkTimer) engine.stopTimer(NS7III.blinkTimer);
    if (NS7III.bpmTimer)   engine.stopTimer(NS7III.bpmTimer);
    for (var s = 0; s < 2; s++) { if (NS7III.motorRunning[s]) NS7III.motorStop(s); }
    for (var i = 2; i <= 5; i++) midi.sendShortMsg(0x90, i, 0x00);
    midi.sendShortMsg(0xB0, 71, 0);
};

// NumarkNS7III.js - ECMA-262 ES5 COMPLIANT MASTER
var NS7III = {};

// Constants
NS7III.MOTOR_CH   = [2, 3]; 
NS7III.RES        = 3600; 
NS7III.PB_RATIO   = 1440; 

NS7III.COL_OFF    = 0x00;
NS7III.COL_RED    = 0x01;
NS7III.COL_RED_DIM = 0x02;
NS7III.COL_GREEN  = 0x10;
NS7III.COL_BLUE   = 0x30;
NS7III.COL_CYAN   = 0x25;
NS7III.COL_CYAN_DIM = 0x20;
NS7III.COL_YELLOW = 0x14;
NS7III.COL_YELLOW_DIM = 0x08;
NS7III.COL_WHITE  = 0x7F;

NS7III.motorRunning  = [false, false];
NS7III.leftDeck  = 1;
NS7III.rightDeck = 2;
NS7III.padMode    = ["hotcue", "hotcue"]; 
NS7III.ROLL_SIZES = ["0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8"];
NS7III.shiftHeld  = [false, false];
NS7III.blinkState = false;

NS7III.jogLastCoarse = [0, 0];
NS7III.jogLastDelta  = [0, 0];
NS7III.jogLastPB     = [8192, 8192];
NS7III.isTouching    = [false, false];
NS7III.touchTimer    = [0, 0];
NS7III.confirmCount  = [0, 0];
NS7III.lsbBEATS      = [0, 0]; 

// Helpers
NS7III.deckForSide = function(side) { 
    return side === 0 ? NS7III.leftDeck : NS7III.rightDeck; 
};
NS7III._sideForDeck = function(deck) { 
    return (deck === 1 || deck === 3) ? 0 : 1; 
};

// Motor Sync
NS7III.syncPhysicalMotor = function(side, rate) {
    if (!NS7III.motorRunning[side]) return;
    var ch = NS7III.MOTOR_CH[side];
    var deck = NS7III.deckForSide(side);
    var isReverse = engine.getValue("[Channel"+deck+"]", "reverse");
    var targetRPM = Math.round(64 + ((isReverse ? -rate : rate) * 32));
    targetRPM = Math.max(1, Math.min(127, targetRPM));
    midi.sendShortMsg(0xB0 | (ch - 1), 105, targetRPM);
    midi.sendShortMsg(0xB0 | (ch - 1), 67, 127);
    midi.sendShortMsg(0xB0, 74, 20);
    midi.sendShortMsg(0xB0, 75, 20);
};

NS7III._onPlayChange = function(v, g, k) { 
    var match = g.match(/\d+/);
    if (!match) return;
    var d = parseInt(match[0], 10);
    var s = NS7III._sideForDeck(d); 
    if (v > 0) { 
        if (!NS7III.motorRunning[s]) NS7III.motorStart(s); 
    } else { 
        if (NS7III.motorRunning[s]) NS7III.motorStop(s); 
    } 
};

NS7III.motorStart = function(side) { 
    var ch = NS7III.MOTOR_CH[side];
    var deck = NS7III.deckForSide(side); 
    if (engine.isScratching(deck)) engine.scratchDisable(deck, false); 
    midi.sendShortMsg(0xB0, 75, 0); 
    NS7III.motorRunning[side] = true; 
    NS7III.syncPhysicalMotor(side, engine.getValue("[Channel"+deck+"]", "rate")); 
};

NS7III.motorStop = function(side) { 
    var ch = NS7III.MOTOR_CH[side];
    var deck = NS7III.deckForSide(side); 
    if (engine.isScratching(deck)) engine.scratchDisable(deck, true); 
    midi.sendShortMsg(0xB0 | (ch - 1), 67, 0); 
    midi.sendShortMsg(0xB0 | (ch - 1), 66, 127); 
    NS7III.motorRunning[side] = false; 
};

// Jog Logic
NS7III.jogSpin = function(c, n, v, s, g) {
    var side = (s & 0x0F) - 1; 
    if (side < 0 || side > 1) return;
    var deck = NS7III.deckForSide(side);
    var delta = v - NS7III.jogLastCoarse[side];
    if (delta > 64) delta -= 128; else if (delta < -64) delta += 128;
    NS7III.jogLastDelta[side] = delta; 
    if (NS7III.isTouching[side]) engine.scratchTick(deck, delta);
    NS7III.jogLastCoarse[side] = v;
};

NS7III.jogPB = function(c, n, v, s, g) {
    var side = (s & 0x0F) - 1; 
    if (side < 0 || side > 1) return;
    var deck = NS7III.deckForSide(side);
    var currentPB = (v << 7) | n;
    var deltaPB = currentPB - NS7III.jogLastPB[side];
    if (deltaPB > 8192) deltaPB -= 16384; else if (deltaPB < -8192) deltaPB += 16384;
    var slipError = Math.abs(deltaPB - (NS7III.jogLastDelta[side] * NS7III.PB_RATIO));
    if (slipError > 800 || (NS7III.jogLastDelta[side] === 0 && NS7III.motorRunning[side])) {
        NS7III.confirmCount[side]++;
        if (NS7III.confirmCount[side] >= 3) {
            if (!NS7III.isTouching[side]) { 
                engine.scratchEnable(deck, NS7III.RES, 33.333, 1.0, 1.0/32.0, false, false); 
                NS7III.isTouching[side] = true; 
            }
            if (NS7III.touchTimer[side]) engine.stopTimer(NS7III.touchTimer[side]);
            NS7III.touchTimer[side] = engine.beginTimer(50, function() {
                NS7III.touchTimer[side] = 0; 
                NS7III.isTouching[side] = false;
                NS7III.confirmCount[side] = 0; 
                engine.scratchDisable(deck, true);
            }, true);
        }
    } else { 
        if (NS7III.confirmCount[side] > 0) NS7III.confirmCount[side]--; 
    }
    NS7III.jogLastPB[side] = currentPB;
};

// FX Encoders
NS7III.fxEncoder = function(channel, control, value, status, group) {
    var delta = (value === 1 || value === 2) ? 0.02 : -0.02;
    engine.setValue(group, "meta", Math.max(0, Math.min(1, engine.getValue(group, "meta") + delta)));
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

NS7III.filterToggle = function(channel, control, value, status, group) {
    if (value > 0) engine.setValue(group, "filter_enabled", !engine.getValue(group, "filter_enabled"));
};

// Pads
NS7III.pad = function(c, n, v, status) {
    var side = NS7III._sideForDeck(c);
    var p = n - 70;
    var group = "[Channel" + c + "]";
    var type = status & 0xF0;
    if (type === 0xA0) return; 
    var isRelease = (type === 0x80) || (type === 0x90 && v === 0);

    if (NS7III.padMode[side] === "hotcue") {
        if (!isRelease) engine.setValue(group, "hotcue_" + p + "_" + (NS7III.shiftHeld[side] ? "clear" : "activate"), 1);
    } else if (NS7III.padMode[side] === "autoloop") {
        if (!isRelease) engine.setValue(group, "beatloop_" + NS7III.ROLL_SIZES[p-1] + "_toggle", 1);
    } else if (NS7III.padMode[side] === "roll") {
        if (!isRelease) engine.setValue(group, "beatloop_" + NS7III.ROLL_SIZES[p-1] + "_activate", 1);
        else engine.setValue(group, "loop_enabled", 0);
    } else if (NS7III.padMode[side] === "manualloop") {
        if (!isRelease) {
            if (p === 1) engine.setValue(group, "loop_in", 1);
            else if (p === 2) engine.setValue(group, "loop_out", 1);
            else if (p === 3) engine.setValue(group, "loop_halve", 1);
            else if (p === 4) engine.setValue(group, "loop_double", 1);
            else if (p === 5) engine.setValue(group, "reloop_toggle", 1);
        }
    }
};

NS7III.padModeCues = function(c, n, v) { 
    if (v > 0) { 
        var s = NS7III._sideForDeck(c); 
        NS7III.padMode[s] = "hotcue"; 
        NS7III._updatePadModeLeds(s); 
        NS7III._refreshPadColors(s); 
    } 
};
NS7III.padModeAutoRoll = function(c, n, v) { 
    if (v > 0) { 
        var s = NS7III._sideForDeck(c); 
        NS7III.padMode[s] = (NS7III.padMode[s] === "autoloop") ? "roll" : "autoloop"; 
        NS7III._updatePadModeLeds(s); 
        NS7III._refreshPadColors(s); 
    } 
};
NS7III.padModeManual = function(c, n, v) { 
    if (v > 0) { 
        var s = NS7III._sideForDeck(c); 
        NS7III.padMode[s] = "manualloop"; 
        NS7III._updatePadModeLeds(s); 
        NS7III._refreshPadColors(s); 
    } 
};

// Navigation
NS7III.libraryScroll = function(c, n, v) { 
    engine.setValue("[Library]", "MoveVertical", (v === 1) ? -1 : 1); 
};
NS7III.needleSearch = function(c, n, v, s, g) { 
    var side = (s & 0x0F) - 1; 
    engine.setValue("[Channel"+NS7III.deckForSide(side)+"]", "playposition", v / 127.0); 
};
NS7III.pitch = function(d, n, v) { 
    var norm = (v - 63.5) / 63.5; 
    if (Math.abs(norm) < 0.01) norm = 0; 
    engine.setValue("[Channel" + d + "]", "rate", norm); 
    NS7III.syncPhysicalMotor(NS7III._sideForDeck(d), norm); 
};
NS7III.pitchA = function(c, n, v) { NS7III.pitch(NS7III.leftDeck, n, v); };
NS7III.pitchB = function(c, n, v) { NS7III.pitch(NS7III.rightDeck, n, v); };
NS7III.paramLeft = function(c, n, v) { if (v > 0) engine.setValue("[Channel" + c + "]", "loop_halve", 1); };
NS7III.paramRight = function(c, n, v) { if (v > 0) engine.setValue("[Channel" + c + "]", "loop_double", 1); };

NS7III.deckSel1 = function(v) { if(v>0) { NS7III.leftDeck = 1; NS7III._updatePadModeLeds(0); NS7III._refreshPadColors(0); } };
NS7III.deckSel2 = function(v) { if(v>0) { NS7III.rightDeck = 2; NS7III._updatePadModeLeds(1); NS7III._refreshPadColors(1); } };
NS7III.deckSel3 = function(v) { if(v>0) { NS7III.leftDeck = 3; NS7III._updatePadModeLeds(0); NS7III._refreshPadColors(0); } };
NS7III.deckSel4 = function(v) { if(v>0) { NS7III.rightDeck = 4; NS7III._updatePadModeLeds(1); NS7III._refreshPadColors(1); } };

NS7III.play = function(c) { 
    var s = NS7III._sideForDeck(c);
    var d = NS7III.deckForSide(s); 
    engine.setValue("[Channel" + d + "]", "play", !engine.getValue("[Channel" + d + "]", "play")); 
};
NS7III.load = function(c, n, v) { if (v > 0) engine.setValue("[Channel" + c + "]", "LoadSelectedTrack", 1); };
NS7III.shift = function(c, n, v) { NS7III.shiftHeld[NS7III._sideForDeck(c)] = (v > 0); };
NS7III.cue = function(c, n, v) { engine.setValue("[Channel" + c + "]", "cue_default", v > 0 ? 1 : 0); };
NS7III.sync = function(c, n, v) { if (v > 0) engine.setValue("[Channel" + c + "]", "sync_enabled", !engine.getValue("[Channel" + c + "]", "sync_enabled")); };
NS7III.bleep = function(c, n, v, s) { 
    var d = "[Channel" + c + "]";
    var side = NS7III._sideForDeck(c); 
    var rel = (s & 0xF0) === 0x80; 
    if (!rel) { 
        engine.setValue(d, "slip_enabled", 1); 
        engine.setValue(d, "reverse", 1); 
    } else { 
        engine.setValue(d, "reverse", 0); 
        engine.setValue(d, "slip_enabled", 0); 
    } 
    NS7III.syncPhysicalMotor(side, engine.getValue(d, "rate")); 
};
NS7III.reverse = function(c, n, v, s) { 
    var d = "[Channel" + c + "]";
    var side = NS7III._sideForDeck(c); 
    var rel = (s & 0xF0) === 0x80; 
    engine.setValue(d, "reverse", rel ? 0 : 1); 
    NS7III.syncPhysicalMotor(side, engine.getValue(d, "rate")); 
};

// LEDs
NS7III._onBlinkTick = function() { 
    NS7III.blinkState = !NS7III.blinkState; 
    for (var s = 0; s < 2; s++) NS7III._refreshPadColors(s); 
};
NS7III._updatePadModeLeds = function(side) { 
    var s = 0x91 + side; 
    midi.sendShortMsg(s, 79, NS7III.padMode[side]==="hotcue"?NS7III.COL_GREEN:NS7III.COL_OFF); 
    midi.sendShortMsg(s, 114, NS7III.padMode[side]==="autoloop"?NS7III.COL_BLUE:NS7III.COL_OFF); 
    midi.sendShortMsg(s, 80, NS7III.padMode[side]==="roll"?NS7III.COL_RED:NS7III.COL_OFF); 
    midi.sendShortMsg(s, 81, NS7III.padMode[side]==="manualloop"?NS7III.COL_YELLOW:NS7III.COL_OFF); 
};
NS7III._refreshPadColors = function(side) { 
    var deck = NS7III.deckForSide(side);
    var s = 0x91 + side;
    var group = "[Channel" + deck + "]"; 
    var mode = NS7III.padMode[side]; 
    for (var i = 1; i <= 8; i++) { 
        var color = NS7III.COL_OFF; 
        if (mode === "hotcue") {
            color = engine.getValue(group, "hotcue_"+i+"_status") ? NS7III.COL_GREEN : NS7III.COL_OFF; 
        } else if (mode === "autoloop") { 
            var active = engine.getValue(group, "beatloop_"+NS7III.ROLL_SIZES[i-1]+"_enabled"); 
            color = active ? (NS7III.blinkState ? NS7III.COL_WHITE : NS7III.COL_BLUE) : NS7III.COL_CYAN_DIM; 
        } else if (mode === "roll") { 
            var rollActive = engine.getValue(group, "beatloop_"+NS7III.ROLL_SIZES[i-1]+"_enabled"); 
            color = rollActive ? NS7III.COL_WHITE : NS7III.COL_RED_DIM; 
        } else if (mode === "manualloop") { 
            if (i === 1) color = engine.getValue(group, "loop_in") ? NS7III.COL_WHITE : NS7III.COL_YELLOW_DIM; 
            else if (i === 2) color = engine.getValue(group, "loop_out") ? NS7III.COL_WHITE : NS7III.COL_YELLOW_DIM; 
            else if (i === 5) color = engine.getValue(group, "loop_enabled") ? (NS7III.blinkState ? NS7III.COL_WHITE : NS7III.COL_YELLOW) : NS7III.COL_OFF; 
            else if (i <= 4) color = NS7III.COL_YELLOW_DIM; 
        } 
        midi.sendShortMsg(s, 70+i, color); 
    } 
};

NS7III._connectLedsForDeck = function(deck) {
    var g = "[Channel" + deck + "]";
    var side = NS7III._sideForDeck(deck);
    var s = 0x91 + side;
    if (engine.getValue(g, "play") === undefined) return;

    [["52","play_indicator"],["51","cue_indicator"],["50","sync_enabled"]].forEach(function(m){ 
        var conn = engine.makeConnection(g, m[1], function(v){ 
            if(NS7III.deckForSide(side) === deck) midi.sendShortMsg(s, parseInt(m[0], 10), v?0x7F:0x00); 
        });
        if (conn) conn.trigger();
    });

    for(var i=1;i<=8;i++) {
        (function(n){ 
            var c1 = engine.makeConnection(g, "hotcue_"+n+"_status", function(v){ 
                if (NS7III.deckForSide(side) === deck && NS7III.padMode[side] === "hotcue") NS7III._refreshPadColors(side); 
            }); 
            if (c1) c1.trigger();
            var c2 = engine.makeConnection(g, "beatloop_"+NS7III.ROLL_SIZES[n-1]+"_enabled", function(v){ 
                if (NS7III.deckForSide(side) === deck && (NS7III.padMode[side] === "autoloop" || NS7III.padMode[side] === "roll")) NS7III._refreshPadColors(side); 
            }); 
            if (c2) c2.trigger();
        })(i);
    }

    var cL = engine.makeConnection(g, "loop_enabled", function(v){ 
        if (NS7III.deckForSide(side) === deck && NS7III.padMode[side] === "manualloop") NS7III._refreshPadColors(side); 
    });
    if (cL) cL.trigger();

    engine.makeConnection(g, "rate", function(v){ NS7III.syncPhysicalMotor(side, v); });
    engine.makeConnection(g, "reverse", function(v){ NS7III.syncPhysicalMotor(side, engine.getValue(g, "rate")); });
    
    var filterNotes = [0, 35, 37, 39, 41];
    var bNotes = [0, 36, 38, 40, 42];
    var fConn = engine.makeConnection(g, "filter_enabled", function(v){ 
        midi.sendShortMsg(0x90, filterNotes[deck], v ? 0x7F : 0x00); 
        midi.sendShortMsg(0x90, bNotes[deck], v ? 0x7F : 0x00); 
    });
    if (fConn) fConn.trigger();

    engine.makeConnection(g, "play", NS7III._onPlayChange);
};

NS7III.init = function() {
    midi.sendShortMsg(0xB0, 71, 0); 
    midi.sendShortMsg(0xB0, 74, 0); 
    midi.sendShortMsg(0xB0, 75, 0);
    for(var d=1;d<=4;d++) NS7III._connectLedsForDeck(d);
    NS7III._updatePadModeLeds(0); 
    NS7III._updatePadModeLeds(1);
    NS7III.blinkTimer = engine.beginTimer(500, NS7III._onBlinkTick);
};

NS7III.shutdown = function() {
    if (NS7III.blinkTimer) engine.stopTimer(NS7III.blinkTimer);
    for(var s=0;s<2;s++) { 
        if (NS7III.motorRunning[s]) NS7III.motorStop(s); 
    }
    for(var n=2;n<=5;n++) midi.sendShortMsg(0x90, n, 0x00);
};

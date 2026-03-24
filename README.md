
# Numark NS7III Mapping (Mixxx 2.5.4)

## 1. Core Architecture
*   **Engine:** ECMA-262 ES5 (QtScript).
*   **Tracking:** Bidirectional Master Clock synchronization. Playhead is decoupled from motor jitter during normal playback; 1:1 tracking is gated by mechanical slip detection.
*   **Polling:** Optimized for zero-lag high-frequency MIDI streams.

## 2. Motor & Jog Logic
*   **Physical Resolution:** 3,600 ticks/revolution (Optical Encoder CC 0).
*   **Slip Sensor:** 14-bit Pitch Bend (PB) delta tracking. 
*   **Mathematical Ratio:** `1 CC0 Tick : 1440 PB units`.
*   **Slip Trigger:** `Math.abs(deltaPB - (deltaCC0 * 1440)) > 600`.
*   **Exit Confidence:** Required 8 consecutive packets of synchronized motor/platter data to disable scratch mode.
*   **Hysteresis:** 2-tick deadzone during stationary hold to filter magnetic motor tug.

## 3. High-Resolution Controls
*   **Pitch Fader:** 14-bit MSB/LSB implementation (CC 1 / CC 33).
    *   Resolution: 16,384 steps.
    *   Formula: `norm = (8192.0 - ((MSB << 7) | LSB)) / 8192.0`.
*   **BEATS Knobs:** 14-bit MSB/LSB (CC 24/56 and CC 75/107).
*   **MIDI Management:** Change-only RPM updates (CC 105) to prevent buffer flooding.

## 4. MIDI Map (Channel 1-5)
| Control | MIDI Type | ID | Function |
| :--- | :--- | :--- | :--- |
| **Deck 1** | NoteOn | 52/51/50 | Play / Cue / Sync (Status 0x91) |
| **Deck 2** | NoteOn | 52/51/50 | Play / Cue / Sync (Status 0x92) |
| **Deck 3** | NoteOn | 52/51/50 | Play / Cue / Sync (Status 0x93) |
| **Deck 4** | NoteOn | 52/51/50 | Play / Cue / Sync (Status 0x94) |
| **Pads 1-8** | NoteOn/Off | 71-78 | Cues/Rolls/Loops (Status 0x91-94) |
| **Reverse** | NoteOn/Off | 63 | Latching Motor/Audio Reverse |
| **Bleep** | NoteOn/Off | 62 | Momentary Slip-Reverse |
| **Param < / >**| NoteOn | 69 / 70 | Loop Halve / Double |
| **Range** | NoteOn | 61 | Cycle Pitch Range (8/16/50) |
| **Deck Sel** | NoteOn | 2 / 3 / 4 / 5 | Active Layer Selection |

## 5. Library Implementation
*   **CRATE:** `MoveLeft` (Note 11)
*   **FILES:** `MoveRight` (Note 9)
*   **PREPARE:** `PreviewDeck1` (Note 10)
*   **LOAD PREPARE:** `AutoDJ Add` (Note 12)
*   **Encoder:** `GoToItem` (Note 8)
*   **Touch:** 108 (Explicitly Ignored)


*   **Mixxx Version:** 2.5.4+

```
░▒▓███████▓▒░       ░▒▓█▓▒░░▒▓██████▓▒░░▒▓██████████████▓▒░░▒▓███████▓▒░  
░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓███████▓▒░ ░▒▓██████▓▒░ ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░
```
by-product of the djcmd project


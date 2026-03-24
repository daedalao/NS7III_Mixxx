# Numark NS7III Mapping (Mixxx 2.5.4)

## 1. Core Architecture
*   **Engine:** ECMA-262 ES5 (QtScript).
*   **Tracking:** Bidirectional Master Clock synchronization. Playhead decoupled from motor jitter; 1:1 tracking gated by mechanical slip detection.
*   **Polling:** Optimized for zero-lag high-frequency MIDI streams.

## 2. Motor & Jog Logic
*   **Physical Resolution:** 3,600 ticks/revolution (Optical Encoder CC 0).
*   **Slip Sensor:** 14-bit Pitch Bend (PB) delta tracking. 
*   **Ratio:** `1 CC0 Tick : 1440 PB units`.
*   **Exit Confidence:** 8-packet synchronization requirement to prevent "play-briefly" jitter while holding.
*   **Hysteresis:** 2-tick deadzone during stationary hold.

## 3. High-Resolution Controls
*   **Pitch Fader:** 14-bit MSB/LSB (CC 1 / CC 33) = 16,384 steps.
*   **BEATS Knobs:** 14-bit MSB/LSB (CC 24/56 and CC 75/107).
*   **Traffic Control:** Change-only RPM updates (CC 105) to eliminate MIDI buffer flooding.

## 4. Requirements
*   **Mixxx Version:** 2.5.4+
*   **Preferences:** `Invert Rate Fader` [ENABLED] for turntable-correct motor sync.

## 5. Full MIDI Map Reference

### Global Mixer & Navigation (Channel 1 | Status 0xB0, 0x90)
| Control | MIDI ID | Function | Logic |
| :--- | :--- | :--- | :--- |
| **Crossfader** | CC 7 | `[Master] crossfader` | Absolute |
| **Master Gain** | CC 66 | `[Master] gain` | Absolute |
| **Booth Gain** | CC 67 | `[Master] booth_gain` | Absolute |
| **Library Scroll** | CC 3 | `[Library] MoveVertical` | Relative Encoder |
| **Library Enter** | Note 8 | `[Library] GoToItem` | Press |
| **Library Back** | Note 6 | `[Library] MoveLeft` | Press |
| **Library Fwd** | Note 7 | `[Library] MoveRight` | Press |
| **CRATE Button** | Note 11 | `[Library] MoveLeft` | Sidebar Focus |
| **FILES Button** | Note 9 | `[Library] MoveRight` | Tracklist Focus |
| **PREPARE Btn** | Note 10 | `[PreviewDeck1] LoadAndPlay`| Instant Preview |
| **LOAD PREP** | Note 12 | `[AutoDJ] AddSelectedTrack` | Queue Track |
| **Deck 1-4 Sel** | Notes 2-5 | Layer Switching | Script Handled |
| **Filter A/B** | Notes 35-42| `filter_enabled` | Toggle + LED |

### Deck Strips (EQ & Volume)
| Control | Deck 1 (Ch1) | Deck 2 (Ch2) | Deck 3 (Ch3) | Deck 4 (Ch4) |
| :--- | :--- | :--- | :--- | :--- |
| **Volume** | CC 8 | CC 13 | CC 19 | CC 24 |
| **Pregain** | CC 12 | CC 17 | CC 23 | CC 28 |
| **EQ Low** | CC 9 | CC 14 | CC 20 | CC 25 |
| **EQ Mid** | CC 10 | CC 15 | CC 21 | CC 26 |
| **EQ High** | CC 11 | CC 16 | CC 22 | CC 27 |
| **QuickFilter** | CC 91 | CC 92 | CC 90 | CC 93 |

### FX Units (14-bit & Relative)
| Control | Unit 1 (Left) | Unit 2 (Right) |
| :--- | :--- | :--- |
| **Knobs 1-3** | CC 4, 5, 6 | CC 72, 73, 74 |
| **BEATS (Mix)** | CC 24/56 (14-bit) | CC 75/107 (14-bit) |
| **Buttons 1-4** | Notes 15, 16, 17, 18| Notes 19, 20, 21, 22|

### Deck Layer Transport (Channels 2-5 | Status 0x91-0x94)
| Control | MIDI ID | Function |
| :--- | :--- | :--- |
| **Play / Cue** | Note 52 / 51 | Transport Trigger |
| **Sync / Load** | Note 50 / 49 | Engine Sync / Track Load |
| **Shift** | Note 53 | Modifier State |
| **Reverse** | Note 63 | Latching Motor/Audio Reverse |
| **Bleep** | Note 62 | Momentary Slip-Reverse |
| **Param < / >** | Note 69 / 70 | Loop Halve / Double |
| **Pitch Range** | Note 61 | Cycle 8% / 16% / 50% |
| **Pads 1-8** | Note 71-78 | Cues/Rolls/Loops |

### Platter Encoders (Static Hardware Channels)
| Control | Left (Ch 2) | Right (Ch 3) |
| :--- | :--- | :--- |
| **Vinyl Encoder**| CC 0 (3600 ticks) | CC 0 (3600 ticks) |
| **Slip Tension** | Pitch Bend (14-bit) | Pitch Bend (14-bit) |
| **Pitch Fader** | CC 1/33 (14-bit) | CC 1/33 (14-bit) |
| **Touch Strip** | CC 2 (Absolute) | CC 2 (Absolute) |

by-product of the djcmd project
```
░▒▓███████▓▒░       ░▒▓█▓▒░░▒▓██████▓▒░░▒▓██████████████▓▒░░▒▓███████▓▒░  
░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ 
░▒▓███████▓▒░ ░▒▓██████▓▒░ ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░
```

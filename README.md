# AI Debate Simulator

Practice a live, spoken debate against AI candidates who answer in their own voice, in character, in real time.

## Why it exists

Debate prep usually needs a sparring partner. This app gives you one on demand: you speak the moderator's question and your answer, and an AI candidate with a defined background, policy platform and speaking style responds to both, out loud, through OpenAI's Realtime speech-to-speech API.

## Features

- **Structured debate flow**: record the moderator question, record the human candidate's answer, then generate the AI candidate's rebuttal.
- **Context-aware rebuttals**: the AI hears both the question and your answer and responds to each.
- **19 fictional candidates**: from policy-heavy (a Texas governor, a surgeon, a tech founder, a veteran) to comic personas (a noir detective, a Shakespearean statesman, a Gen Z candidate).
- **Custom candidates**: write your own profile (background, positions, style, strategy) in the UI.
- **8 OpenAI voices** with in-app voice previews.
- **Speech recognition** in the browser for transcribing the question and answer (Chrome/Edge).
- **Optional audio diagnostics**: set `ENABLE_AUDIO_CAPTURE=true` to save AI response audio to `server/debug/` and inspect it with `npm run analyze-audio`.

## Quickstart

Requires Node.js 18+, an OpenAI API key with Realtime API access, and Chrome or Edge.

```bash
git clone <repository-url> ai-debate-simulator
cd ai-debate-simulator
npm run install-all
cp server/.env.example server/.env   # then set OPENAI_API_KEY (or run: npm run setup)
npm run dev
```

The API runs on http://localhost:3001 and the React app on http://localhost:3000.

Production: `npm run build` (builds the client), then `npm start`.

## How to use

1. Pick a candidate and a voice, then click **Start Debate Session**.
2. **Record Question**: speak the moderator's question.
3. **Record Response**: speak the human candidate's answer.
4. **Generate AI Response**: the AI candidate answers the question and rebuts you, in voice.

To add a built-in candidate, add an entry to `CANDIDATE_CONFIGS` in `server/index.js` (`name`, `background`, `party`, `instructions`, `voice`, `model`).

## Architecture

- **Server** (`server/index.js`): Express + Socket.IO. Each browser session gets its own WebSocket to the OpenAI Realtime API (`gpt-4o-realtime-preview`); the server forwards debate context and streams audio deltas back.
- **Client** (`client/`): Create React App. Web Speech API for transcription, Web Audio API with a queued, gain-controlled playback graph so response chunks play in order without clicks.
- **REST endpoints**: `GET /api/candidates`, `POST /api/candidates/custom`, `POST /api/voice-preview`, `GET /health`.
- **Candidates** are plain prompt configs (identity, positions, style, debate strategy) kept in memory; custom ones last until the server restarts.
- **Diagnostics**: `scripts/analyze-audio.js` scans captured WAV files for amplitude discontinuities (audible clicks).

## Configuration

| Variable | Description | Required |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI key with Realtime API access | Yes |
| `PORT` | Server port (default 3001) | No |
| `ENABLE_AUDIO_CAPTURE` | `true` saves AI response audio to `server/debug/` | No |

## Testing

There is no automated test suite yet. `npm run build` compiles the client, and `cd client && CI=true npx react-scripts test --watchAll=false --passWithNoTests` runs the (empty) Jest setup.

## Troubleshooting

- **No transcription**: speech recognition needs Chrome or Edge and microphone permission.
- **Connection error**: check that `OPENAI_API_KEY` is set and the key has Realtime API access.
- **Microphone blocked in production**: browsers require HTTPS for microphone access off localhost.

## License

MIT. Copyright (c) 2026 Pritesh Patel. See [LICENSE](LICENSE).

All candidates are fictional characters. Any resemblance to real people is coincidental.

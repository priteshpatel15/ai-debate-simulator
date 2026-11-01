#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_AUDIO_DIR = path.resolve(__dirname, '../server/debug/audio');
const DEFAULT_THRESHOLD = 0.45; // absolute amplitude delta considered a click

const args = process.argv.slice(2);
let targetFile = null;
let threshold = DEFAULT_THRESHOLD;
let samplesAroundEvent = 48;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--file' || arg === '-f') {
    targetFile = args[i + 1];
    i += 1;
  } else if (arg === '--threshold' || arg === '-t') {
    threshold = parseFloat(args[i + 1]);
    i += 1;
  } else if (arg === '--window' || arg === '-w') {
    samplesAroundEvent = parseInt(args[i + 1], 10);
    i += 1;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/analyze-audio.js [options]

Options:
  -f, --file <path>       Path to WAV file. Defaults to latest capture in server/debug/audio
  -t, --threshold <value> Amplitude delta threshold for click detection (default ${DEFAULT_THRESHOLD})
  -w, --window <samples>  Number of samples of context to display around detected clicks (default 48)
  -h, --help              Show this help message
`);
}

function findLatestWav(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return null;
  }
  const entries = fs.readdirSync(dirPath)
    .filter((file) => file.toLowerCase().endsWith('.wav'))
    .map((file) => ({ file, fullPath: path.join(dirPath, file) }))
    .sort((a, b) => fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs);

  return entries.length > 0 ? entries[0].fullPath : null;
}

function readWav(filePath) {
  const buffer = fs.readFileSync(filePath);

  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF file');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAVE file');
  }

  let offset = 12;
  let audioFormat;
  let numChannels;
  let sampleRate;
  let bitsPerSample;
  let dataStart = null;
  let dataLength = null;

  while (offset < buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      audioFormat = buffer.readUInt16LE(chunkStart);
      numChannels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataStart = chunkStart;
      dataLength = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (audioFormat !== 1) {
    throw new Error('Only PCM WAVE files are supported');
  }
  if (bitsPerSample !== 16) {
    throw new Error('Only 16-bit PCM is supported');
  }
  if (dataStart == null || dataLength == null) {
    throw new Error('No data chunk found in WAV file');
  }

  const samples = new Int16Array(buffer.buffer, buffer.byteOffset + dataStart, dataLength / 2);

  return {
    sampleRate,
    numChannels,
    samples,
    durationSeconds: samples.length / sampleRate / numChannels,
  };
}

function formatTime(seconds) {
  const ms = Math.floor(seconds * 1000);
  const s = Math.floor(ms / 1000);
  const remainder = ms % 1000;
  return `${s}.${remainder.toString().padStart(3, '0')}s`;
}

function detectClicks(samples, sampleRate, numChannels) {
  const monoLength = samples.length / numChannels;
  const peaks = [];
  let maxDelta = 0;
  let sumDelta = 0;
  let countDelta = 0;

  for (let frame = 1; frame < monoLength; frame += 1) {
    for (let channel = 0; channel < numChannels; channel += 1) {
      const index = frame * numChannels + channel;
      const prevIndex = (frame - 1) * numChannels + channel;
      const current = samples[index] / 32768;
      const prev = samples[prevIndex] / 32768;
      const delta = Math.abs(current - prev);

      maxDelta = Math.max(maxDelta, delta);
      sumDelta += delta;
      countDelta += 1;

      if (delta >= threshold) {
        peaks.push({
          frame,
          channel,
          delta,
          timeSeconds: frame / sampleRate,
        });
      }
    }
  }

  return {
    peaks,
    maxDelta,
    avgDelta: countDelta > 0 ? sumDelta / countDelta : 0,
  };
}

function renderSampleContext(samples, numChannels, centerFrame, windowSize) {
  const startFrame = Math.max(0, centerFrame - windowSize);
  const endFrame = Math.min(samples.length / numChannels, centerFrame + windowSize);
  const rows = [];

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const values = [];
    for (let channel = 0; channel < numChannels; channel += 1) {
      const sample = samples[frame * numChannels + channel] / 32768;
      values.push(sample.toFixed(4));
    }
    const marker = frame === centerFrame ? '>>' : '  ';
    rows.push(`${marker} frame ${frame.toString().padStart(6, ' ')} | ${values.join('  ')}`);
  }

  return rows.join('\n');
}

function analyzeFile(filePath) {
  const { sampleRate, numChannels, samples, durationSeconds } = readWav(filePath);
  console.log(`Analyzing ${filePath}`);
  console.log(`Sample rate: ${sampleRate} Hz | Channels: ${numChannels} | Duration: ${durationSeconds.toFixed(2)}s | Total samples: ${samples.length}`);
  console.log(`Threshold: ${threshold}`);

  const clickAnalysis = detectClicks(samples, sampleRate, numChannels);

  console.log(`Max per-sample delta: ${clickAnalysis.maxDelta.toFixed(4)} | Avg delta: ${clickAnalysis.avgDelta.toFixed(6)}`);
  if (clickAnalysis.peaks.length === 0) {
    console.log('No clicks above threshold detected.');
    return;
  }

  console.log(`Detected ${clickAnalysis.peaks.length} potential click(s):`);
  clickAnalysis.peaks.slice(0, 20).forEach((peak, idx) => {
    console.log(`  [${idx + 1}] ${formatTime(peak.timeSeconds)} (frame ${peak.frame}, channel ${peak.channel}) delta=${peak.delta.toFixed(4)}`);
    if (samplesAroundEvent > 0) {
      console.log(renderSampleContext(samples, numChannels, peak.frame, samplesAroundEvent));
    }
  });

  if (clickAnalysis.peaks.length > 20) {
    console.log(`  ...and ${clickAnalysis.peaks.length - 20} more (increase --window or adjust threshold to inspect).`);
  }
}

function main() {
  let filePath = targetFile;

  if (!filePath) {
    filePath = findLatestWav(DEFAULT_AUDIO_DIR);
    if (!filePath) {
      console.error(`No WAV files found. Recordings are stored in ${DEFAULT_AUDIO_DIR}`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  try {
    analyzeFile(filePath);
  } catch (error) {
    console.error('Failed to analyze audio', error);
    process.exit(1);
  }
}

main();

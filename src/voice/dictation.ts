import { execFile, spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminateProcessTree } from '../runtime/cancellation';
import type { WhisperEngine } from './whisperInstall';

/** What a spoken keyword does to the composer. */
export type VoiceAction = 'deleteWord' | 'deletePhrase' | 'newLine' | 'clear' | 'send' | 'stop';
export interface VoiceCommand { phrase: string; action: VoiceAction }
/** A dictated result, split into text to insert and keywords to run, in spoken order. */
export type VoicePart = { text: string } | { action: VoiceAction };

export const VOICE_ACTIONS: readonly VoiceAction[] = ['deleteWord', 'deletePhrase', 'newLine', 'clear', 'send', 'stop'];
export const defaultVoiceCommands = (): VoiceCommand[] => [
  { phrase: 'delete word', action: 'deleteWord' },
  { phrase: 'scratch that', action: 'deletePhrase' },
  { phrase: 'new line', action: 'newLine' },
  { phrase: 'clear message', action: 'clear' },
  { phrase: 'send message', action: 'send' },
  { phrase: 'stop listening', action: 'stop' },
];
const MAX_COMMANDS = 30;

/** Accepts any stored value; keeps known actions and the first entry for each phrase. */
export function normalizeVoiceCommands(value: unknown): VoiceCommand[] {
  if (!Array.isArray(value)) return defaultVoiceCommands();
  const seen = new Set<string>();
  const result: VoiceCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { phrase, action } = item as Record<string, unknown>;
    const text = typeof phrase === 'string' ? phrase.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
    if (!text || seen.has(text.toLowerCase()) || !VOICE_ACTIONS.includes(action as VoiceAction)) continue;
    seen.add(text.toLowerCase());
    result.push({ phrase: text, action: action as VoiceAction });
    if (result.length >= MAX_COMMANDS) break;
  }
  return result;
}

/** Splits dictated text on keyword phrases, so "fix it new line thanks" becomes text, newLine, text. */
export function splitVoiceCommands(text: string, commands: VoiceCommand[]): VoicePart[] {
  const phrases = commands.map(command => command.phrase).sort((a, b) => b.length - a.length);
  if (!phrases.length) return text.trim() ? [{ text: text.trim() }] : [];
  const pattern = phrases.map(phrase => phrase.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).join('|');
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])[.,!?]?`, 'giu');
  const parts: VoicePart[] = [];
  let last = 0;
  for (const match of text.matchAll(matcher)) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ text: before });
    const spoken = match[0].replace(/[.,!?]$/, '').replace(/\s+/g, ' ').toLowerCase();
    const command = commands.find(item => item.phrase.toLowerCase() === spoken);
    if (command) parts.push({ action: command.action });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push({ text: rest });
  return parts;
}

// Records the default microphone with winmm (no extra installs) and cuts it into phrases on pauses.
// Each phrase is written as a 16 kHz mono WAV and reported as a JSON line; Whisper transcribes it.
// A "stop" line on stdin ends recording after flushing the phrase in progress, so the last words aren't lost.
const RECORDER = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshRecorder {
	[StructLayout(LayoutKind.Sequential)]
	struct WaveFormat {
		public ushort Tag;
		public ushort Channels;
		public uint SampleRate;
		public uint BytesPerSecond;
		public ushort BlockAlign;
		public ushort BitsPerSample;
		public ushort ExtraSize;
	}

	[StructLayout(LayoutKind.Sequential)]
	struct WaveHeader {
		public IntPtr Data;
		public uint BufferLength;
		public uint BytesRecorded;
		public IntPtr User;
		public uint Flags;
		public uint Loops;
		public IntPtr Next;
		public IntPtr Reserved;
	}

	[DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
	[DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
	[DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, int size);
	[DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
	[DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
	[DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
	[DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);

	const uint WaveMapper = 0xFFFFFFFF;
	const uint HeaderDone = 1;
	const int SampleRate = 16000;
	const int FrameSamples = 800;            // 50 ms
	const int BufferCount = 10;
	const int StartFrames = 3;               // 150 ms of loud audio starts a phrase
	const int EndFrames = 16;                // 800 ms of quiet ends it
	const int PrerollFrames = 8;             // keeps 400 ms before the start so first sounds aren't clipped
	const int MinimumVoicedFrames = 5;
	const int MaximumBytes = SampleRate * 2 * 28;

	static readonly object Gate = new object();
	static volatile bool stopRequested;

	static void Emit(string json) {
		lock (Gate) {
			Console.Out.WriteLine(json);
			Console.Out.Flush();
		}
	}

	static string Quote(string value) {
		return "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
	}

	static void WriteWave(string path, byte[] samples) {
		using (var file = new BinaryWriter(File.Create(path))) {
			file.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
			file.Write(36 + samples.Length);
			file.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));
			file.Write(16);
			file.Write((short)1);
			file.Write((short)1);
			file.Write(SampleRate);
			file.Write(SampleRate * 2);
			file.Write((short)2);
			file.Write((short)16);
			file.Write(System.Text.Encoding.ASCII.GetBytes("data"));
			file.Write(samples.Length);
			file.Write(samples);
		}
	}

	public static void Run(string folder, bool debug) {
		var reader = new Thread(() => {
			while (true) {
				var line = Console.In.ReadLine();
				if (line == null || line.Trim() == "stop") {
					stopRequested = true;
					return;
				}
			}
		});
		reader.IsBackground = true;
		reader.Start();

		var format = new WaveFormat {
			Tag = 1,
			Channels = 1,
			SampleRate = SampleRate,
			BytesPerSecond = SampleRate * 2,
			BlockAlign = 2,
			BitsPerSample = 16,
			ExtraSize = 0,
		};
		IntPtr device;
		var opened = waveInOpen(out device, WaveMapper, ref format, IntPtr.Zero, IntPtr.Zero, 0);
		if (opened == 2 || opened == 6) throw new Exception("No microphone was found.");
		if (opened == 4) throw new Exception("The microphone is being used by another app.");
		if (opened != 0) throw new Exception("Could not open the microphone (winmm error " + opened + ").");

		var headerSize = Marshal.SizeOf(typeof(WaveHeader));
		var frameBytes = FrameSamples * 2;
		var headers = new IntPtr[BufferCount];
		try {
			for (var index = 0; index < BufferCount; index++) {
				var header = new WaveHeader {
					Data = Marshal.AllocHGlobal(frameBytes),
					BufferLength = (uint)frameBytes,
				};
				headers[index] = Marshal.AllocHGlobal(headerSize);
				Marshal.StructureToPtr(header, headers[index], false);
				waveInPrepareHeader(device, headers[index], headerSize);
				waveInAddBuffer(device, headers[index], headerSize);
			}
			if (waveInStart(device) != 0) throw new Exception("Could not start recording from the microphone.");
			Emit("{\"type\":\"listening\"}");

			var preroll = new Queue<byte[]>();
			MemoryStream phrase = null;
			double floor = 150;
			int loudFrames = 0;
			int quietFrames = 0;
			int voicedFrames = 0;
			int phraseNumber = 0;
			int frameNumber = 0;
			double loudest = 0;
			var next = 0;

			Action finishPhrase = () => {
				if (phrase != null && voicedFrames >= MinimumVoicedFrames) {
					var path = Path.Combine(folder, "phrase-" + (++phraseNumber) + ".wav");
					WriteWave(path, phrase.ToArray());
					Emit("{\"type\":\"phrase\",\"path\":" + Quote(path) + "}");
				} else if (phrase != null) {
					Emit("{\"type\":\"discarded\"}");
				}
				phrase = null;
				loudFrames = 0;
				quietFrames = 0;
				voicedFrames = 0;
			};

			while (!stopRequested) {
				var header = (WaveHeader)Marshal.PtrToStructure(headers[next], typeof(WaveHeader));
				if ((header.Flags & HeaderDone) == 0) {
					Thread.Sleep(5);
					continue;
				}
				var frame = new byte[header.BytesRecorded];
				Marshal.Copy(header.Data, frame, 0, frame.Length);
				header.Flags &= ~HeaderDone;
				header.BytesRecorded = 0;
				Marshal.StructureToPtr(header, headers[next], false);
				waveInAddBuffer(device, headers[next], headerSize);
				next = (next + 1) % BufferCount;
				if (frame.Length < 2) continue;

				double sum = 0;
				for (var offset = 0; offset + 1 < frame.Length; offset += 2) {
					double sample = BitConverter.ToInt16(frame, offset);
					sum += sample * sample;
				}
				var level = Math.Sqrt(sum / (frame.Length / 2));
				loudest = Math.Max(loudest, level);
				if (debug && ++frameNumber % 20 == 0) {
					Emit("{\"type\":\"debug\",\"text\":\"level " + (int)loudest + " floor " + (int)floor + "\"}");
					loudest = 0;
				}

				if (phrase == null) {
					preroll.Enqueue(frame);
					if (preroll.Count > PrerollFrames) preroll.Dequeue();
					if (level > Math.Max(floor * 3, 140)) {
						loudFrames++;
						floor = floor * 0.995 + level * 0.005;
					} else {
						loudFrames = 0;
						floor = Math.Max(30, floor * 0.95 + level * 0.05);
					}
					if (loudFrames >= StartFrames) {
						phrase = new MemoryStream();
						foreach (var buffered in preroll) phrase.Write(buffered, 0, buffered.Length);
						preroll.Clear();
						voicedFrames = loudFrames;
						quietFrames = 0;
						Emit("{\"type\":\"speech\"}");
					}
					continue;
				}

				phrase.Write(frame, 0, frame.Length);
				if (level > Math.Max(floor * 2, 90)) {
					voicedFrames++;
					quietFrames = 0;
				} else {
					quietFrames++;
				}
				if (quietFrames >= EndFrames || phrase.Length >= MaximumBytes) finishPhrase();
			}
			finishPhrase();
		} finally {
			waveInReset(device);
			foreach (var pointer in headers) {
				if (pointer == IntPtr.Zero) continue;
				var header = (WaveHeader)Marshal.PtrToStructure(pointer, typeof(WaveHeader));
				waveInUnprepareHeader(device, pointer, headerSize);
				Marshal.FreeHGlobal(header.Data);
				Marshal.FreeHGlobal(pointer);
			}
			waveInClose(device);
		}
	}
}
`;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($data) { [Console]::Out.WriteLine(($data | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -TypeDefinition $env:DSH_VOICE_RECORDER
  [DshRecorder]::Run($env:DSH_VOICE_FOLDER, [bool]$env:DSH_VOICE_DEBUG)
  exit 0
} catch {
  $message = $_.Exception.Message
  if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
  Emit @{ type = 'error'; message = $message }
  exit 1
}
`;

/** Whisper's transcript without sound tags like [BLANK_AUDIO] or (wind blowing). */
export function cleanTranscript(output: string): string {
  return output
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DictationEvents {
  onListening(): void;
  /** Placeholder text: an ellipsis while a phrase is heard or transcribed, empty to clear it. */
  onHypothesis(text: string): void;
  onResult(parts: VoicePart[]): void;
  /** Called once when dictation ends; `error` is set when it failed. */
  onStopped(error?: string): void;
}

const STOP_GRACE = 5_000;
const TRANSCRIBE_TIMEOUT = 60_000;

/** One dictation session: records the default microphone and transcribes each phrase with local Whisper. */
export class Dictation {
  private recorder?: ChildProcessWithoutNullStreams;
  private folder?: string;
  private readonly phrases: string[] = [];
  private transcribing = false;
  private recorderClosed = false;
  private stopping = false;
  private finished = false;
  private failure?: string;
  private stopTimer?: NodeJS.Timeout;

  public constructor(
    private readonly commands: VoiceCommand[],
    private readonly engine: WhisperEngine,
    private readonly events: DictationEvents,
  ) {}

  public async start(): Promise<void> {
    if (process.platform !== 'win32') {
      this.finish('Voice input records with Windows audio, so it only works on Windows.');
      return;
    }
    try {
      this.folder = await mkdtemp(join(tmpdir(), 'dsh-voice-'));
    } catch (error) {
      this.finish(`Could not create a folder for recordings: ${(error as Error).message}`);
      return;
    }
    if (this.finished) return;
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const recorder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, DSH_VOICE_RECORDER: RECORDER, DSH_VOICE_FOLDER: this.folder },
    });
    this.recorder = recorder;
    let buffer = '';
    recorder.stdout.setEncoding('utf8');
    recorder.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handle(line);
      }
    });
    recorder.stderr.on('data', () => undefined);
    recorder.stdin.on('error', () => undefined);
    recorder.on('error', error => this.finish(`Could not start recording: ${error.message}`));
    recorder.on('close', code => {
      this.recorderClosed = true;
      if (code && !this.stopping && !this.failure) this.failure = 'Microphone recording stopped unexpectedly.';
      this.pump();
    });
  }

  /** The first call finishes the phrase in progress before ending; a second call ends at once. */
  public stop(): void {
    if (this.finished) return;
    if (this.stopping || !this.recorder) {
      this.finish();
      return;
    }
    this.stopping = true;
    this.recorder.stdin.write('stop\n');
    this.stopTimer = setTimeout(() => this.finish(), STOP_GRACE + TRANSCRIBE_TIMEOUT);
    setTimeout(() => {
      if (!this.recorderClosed && this.recorder) terminateProcessTree(this.recorder);
    }, STOP_GRACE);
  }

  private handle(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'listening') this.events.onListening();
    else if (event.type === 'speech') this.events.onHypothesis('…');
    else if (event.type === 'discarded' && !this.transcribing && !this.phrases.length) this.events.onHypothesis('');
    else if (event.type === 'phrase' && typeof event.path === 'string') {
      this.phrases.push(event.path);
      this.pump();
    } else if (event.type === 'error') {
      this.failure = typeof event.message === 'string' ? event.message : 'Microphone recording failed.';
    } else if (event.type === 'debug' && process.env.DSH_VOICE_DEBUG) console.log('[voice]', event.text);
  }

  /** Transcribes queued phrases one at a time; ends the session once recording and transcription are both done. */
  private pump(): void {
    if (this.finished || this.transcribing) return;
    const path = this.phrases.shift();
    if (!path) {
      if (this.recorderClosed) this.finish(this.failure);
      return;
    }
    this.transcribing = true;
    const threads = String(Math.max(1, Math.min(8, cpus().length - 1)));
    execFile(
      this.engine.cli,
      ['-m', this.engine.model, '-f', path, '-l', 'en', '-t', threads, '-nt', '-np'],
      { windowsHide: true, timeout: TRANSCRIBE_TIMEOUT, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        this.transcribing = false;
        void rm(path, { force: true }).catch(() => undefined);
        if (this.finished) return;
        if (error) {
          this.finish(`Whisper could not transcribe: ${error.message.split('\n')[0]}`);
          return;
        }
        const text = cleanTranscript(stdout);
        const parts = text ? splitVoiceCommands(text, this.commands) : [];
        if (parts.length) this.events.onResult(parts);
        else if (!this.phrases.length) this.events.onHypothesis('');
        this.pump();
      },
    );
  }

  private finish(error?: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.recorder && !this.recorderClosed) terminateProcessTree(this.recorder);
    if (this.folder) void rm(this.folder, { recursive: true, force: true }).catch(() => undefined);
    this.events.onStopped(error);
  }
}


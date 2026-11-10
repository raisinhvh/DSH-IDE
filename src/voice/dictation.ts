import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateProcessTree } from '../runtime/cancellation';

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

/** Shown when Windows refuses recognition because the online speech privacy setting is off. */
export const VOICE_PRIVACY_ERROR = 'Turn on Online speech recognition in Windows Settings > Privacy & security > Speech to use voice input.';

// Uses the modern Windows recognizer (Windows.Media.SpeechRecognition, the engine behind Win+H voice typing).
// Windows PowerShell can't subscribe to WinRT events, so a small C# bridge is compiled from the system
// WinMetadata at start. It writes JSON lines; the extension stops dictation by ending the process.
// Keywords aren't a separate grammar here: dictation can't be combined with other constraints, so they're
// matched in the dictated text by splitVoiceCommands.
const BRIDGE = String.raw`
using System;
using System.Threading;
using Windows.Foundation;
using Windows.Media.SpeechRecognition;

public static class DshVoice {
	static readonly object Gate = new object();
	static SpeechRecognizer recognizer;

	static void Emit(string json) {
		lock (Gate) {
			Console.Out.WriteLine(json);
			Console.Out.Flush();
		}
	}

	static string Quote(string value) {
		var text = (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t");
		return "\"" + text + "\"";
	}

	static void Fail(string message) {
		Emit("{\"type\":\"error\",\"message\":" + Quote(message) + "}");
		Environment.Exit(1);
	}

	// WinRT calls can fail synchronously or through the async operation; both end up here.
	static string Describe(Exception error) {
		var code = (uint)error.HResult;
		var message = (error.Message ?? "").Replace("The text associated with this error code could not be found.", "").Trim();
		if (code == 0x80045509 || message.Contains("privacy policy")) return "privacy";
		if (code == 0x80070005) return "Windows blocked the microphone. Allow desktop apps to use it in Windows Settings > Privacy & security > Microphone.";
		return message + " (0x" + code.ToString("X8") + ")";
	}

	static T Wait<T>(IAsyncOperation<T> operation) {
		while (operation.Status == AsyncStatus.Started) Thread.Sleep(10);
		if (operation.Status != AsyncStatus.Completed) throw operation.ErrorCode;
		return operation.GetResults();
	}

	static void Wait(IAsyncAction operation) {
		while (operation.Status == AsyncStatus.Started) Thread.Sleep(10);
		if (operation.Status != AsyncStatus.Completed) throw operation.ErrorCode;
		operation.GetResults();
	}

	static void Start() {
		try {
			Wait(recognizer.ContinuousRecognitionSession.StartAsync());
		} catch (Exception error) {
			Fail(Describe(error));
		}
	}

	public static void Run() {
		try {
			recognizer = new SpeechRecognizer();
			var compiled = Wait(recognizer.CompileConstraintsAsync());
			if (compiled.Status != SpeechRecognitionResultStatus.Success) Fail("Windows speech recognition is not available (" + compiled.Status + "). Add a speech language in Windows Settings > Time & language > Speech.");
			recognizer.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromHours(8);
			recognizer.HypothesisGenerated += new TypedEventHandler<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>((sender, args) => {
				Emit("{\"type\":\"hypothesis\",\"text\":" + Quote(args.Hypothesis.Text) + "}");
			});
			recognizer.ContinuousRecognitionSession.ResultGenerated += new TypedEventHandler<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>((sender, args) => {
				var result = args.Result;
				if (result.Status != SpeechRecognitionResultStatus.Success || result.Confidence == SpeechRecognitionConfidence.Rejected) {
					Emit("{\"type\":\"hypothesis\",\"text\":\"\"}");
					return;
				}
				Emit("{\"type\":\"result\",\"text\":" + Quote(result.Text) + "}");
			});
			recognizer.ContinuousRecognitionSession.Completed += new TypedEventHandler<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>((sender, args) => {
				var status = args.Status;
				if (status == SpeechRecognitionResultStatus.TimeoutExceeded || status == SpeechRecognitionResultStatus.PauseLimitExceeded || status == SpeechRecognitionResultStatus.Success) {
					ThreadPool.QueueUserWorkItem(state => Start());
					return;
				}
				if (status == SpeechRecognitionResultStatus.NetworkFailure) Fail("Windows speech recognition needs an internet connection.");
				if (status == SpeechRecognitionResultStatus.MicrophoneUnavailable) Fail("No microphone is available.");
				Fail("Windows speech recognition stopped (" + status + ").");
			});
			Wait(recognizer.ContinuousRecognitionSession.StartAsync());
			Emit("{\"type\":\"listening\"}");
		} catch (Exception error) {
			Fail(Describe(error));
		}
	}
}
`;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($data) { [Console]::Out.WriteLine(($data | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  $framework = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $metadata = Join-Path $env:WINDIR 'System32\WinMetadata'
  $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
  $options = New-Object System.CodeDom.Compiler.CompilerParameters
  $options.GenerateInMemory = $true
  $options.ReferencedAssemblies.AddRange([string[]]@(
    (Join-Path $framework 'System.Runtime.dll'),
    (Join-Path $framework 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    (Join-Path $metadata 'Windows.Foundation.winmd'),
    (Join-Path $metadata 'Windows.Globalization.winmd'),
    (Join-Path $metadata 'Windows.Media.winmd')
  ))
  $compiled = $provider.CompileAssemblyFromSource($options, $env:DSH_VOICE_BRIDGE)
  if ($compiled.Errors.HasErrors) { throw ('Could not load Windows speech recognition: ' + ($compiled.Errors | Select-Object -First 1)) }
  $compiled.CompiledAssembly.GetType('DshVoice').GetMethod('Run').Invoke($null, $null)
  while ($true) { Start-Sleep -Seconds 3600 }
} catch { Emit @{ type = 'error'; message = $_.Exception.Message }; exit 1 }
`;

export interface DictationEvents {
  onListening(): void;
  onHypothesis(text: string): void;
  onResult(parts: VoicePart[]): void;
  /** Called once when dictation ends; `error` is set when it failed. */
  onStopped(error?: string): void;
}

/** One dictation session using Windows speech recognition and the default microphone. */
export class Dictation {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;

  public constructor(private readonly commands: VoiceCommand[], private readonly events: DictationEvents) {}

  public start(): void {
    if (process.platform !== 'win32') { this.finish('Voice input uses Windows speech recognition, so it only works on Windows.'); return; }
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, DSH_VOICE_BRIDGE: BRIDGE },
    });
    this.child = child;
    let buffer = '';
    let failure: string | undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) failure = this.handle(line) ?? failure;
      }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', error => this.finish(`Could not start Windows speech recognition: ${error.message}`));
    child.on('close', code => this.finish(failure ?? (code && !this.stopped ? 'Windows speech recognition stopped unexpectedly.' : undefined)));
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) terminateProcessTree(this.child);
    this.events.onStopped();
  }

  /** Returns an error message when the line reports one. */
  private handle(line: string): string | undefined {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { return undefined; }
    const text = typeof event.text === 'string' ? event.text : '';
    if (event.type === 'listening') this.events.onListening();
    else if (event.type === 'hypothesis') this.events.onHypothesis(text);
    else if (event.type === 'result') {
      const parts = splitVoiceCommands(text, this.commands);
      if (parts.length) this.events.onResult(parts);
    } else if (event.type === 'error') {
      if (event.message === 'privacy') return VOICE_PRIVACY_ERROR;
      return typeof event.message === 'string' ? event.message : 'Windows speech recognition failed.';
    }
    return undefined;
  }

  private finish(error?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) terminateProcessTree(this.child);
    this.events.onStopped(error);
  }
}

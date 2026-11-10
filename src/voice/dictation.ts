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

// System.Speech runs dictation and a keyword grammar side by side, so a keyword said on its own is matched exactly.
// Events go out as JSON lines; the extension stops dictation by ending the process.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit($data) { [Console]::Out.WriteLine(($data | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Speech
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $info = $installed | Where-Object { $_.Culture.Equals([System.Globalization.CultureInfo]::CurrentUICulture) } | Select-Object -First 1
  if (-not $info) { $info = $installed | Select-Object -First 1 }
  if (-not $info) { throw 'No Windows speech recognizer is installed. Add a speech language in Windows Settings > Time & language > Speech.' }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $engine.SetInputToDefaultAudioDevice()
  $dictation = New-Object System.Speech.Recognition.DictationGrammar
  $dictation.Name = 'dictation'
  $engine.LoadGrammar($dictation)
  $phrases = @($env:DSH_VOICE_PHRASES -split "\n" | Where-Object { $_ })
  if ($phrases.Count) {
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($phrase in $phrases) { $choices.Add([string]$phrase) }
    $builder = New-Object System.Speech.Recognition.GrammarBuilder($choices)
    $builder.Culture = $info.Culture
    $keywords = New-Object System.Speech.Recognition.Grammar($builder)
    $keywords.Name = 'keywords'
    $keywords.Priority = 1
    $engine.LoadGrammar($keywords)
  }
  Register-ObjectEvent $engine SpeechHypothesized -SourceIdentifier hypothesis | Out-Null
  Register-ObjectEvent $engine SpeechRecognized -SourceIdentifier recognized | Out-Null
  Register-ObjectEvent $engine RecognizeCompleted -SourceIdentifier completed | Out-Null
  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Emit @{ type = 'listening' }
  while ($true) {
    $next = Wait-Event
    Remove-Event -EventIdentifier $next.EventIdentifier
    $result = $next.SourceEventArgs.Result
    switch ($next.SourceIdentifier) {
      'hypothesis' { if ($result.Grammar.Name -eq 'dictation') { Emit @{ type = 'hypothesis'; text = $result.Text } } }
      'recognized' { Emit @{ type = 'result'; text = $result.Text; grammar = $result.Grammar.Name; confidence = $result.Confidence } }
      'completed' { if ($next.SourceEventArgs.Error) { throw $next.SourceEventArgs.Error.Message }; exit 0 }
    }
  }
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
      env: { ...process.env, DSH_VOICE_PHRASES: this.commands.map(command => command.phrase).join('\n') },
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
    else if (event.type === 'hypothesis' && text) this.events.onHypothesis(text);
    else if (event.type === 'result') {
      // Low-confidence keyword matches are usually other words; dictation keeps whatever it heard.
      if (event.grammar === 'keywords' && Number(event.confidence) < 0.5) return undefined;
      const parts = splitVoiceCommands(text, this.commands);
      if (parts.length) this.events.onResult(parts);
    } else if (event.type === 'error') return typeof event.message === 'string' ? event.message : 'Windows speech recognition failed.';
    return undefined;
  }

  private finish(error?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) terminateProcessTree(this.child);
    this.events.onStopped(error);
  }
}

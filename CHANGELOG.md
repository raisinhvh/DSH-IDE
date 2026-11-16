# Release notes

## 1.1.4

Connect local and self-hosted models through any OpenAI-compatible server.

- Add Self-hosted accounts with a server base URL and an API key stored in the editor's SecretStorage.
- Load the server's available model IDs from the model editor and use them in chat or subagent routes, including separately served LoRA adapters.
- Support HTTP for localhost and private LAN endpoints; remote endpoints require HTTPS.
- Hide usage controls for self-hosted accounts, which do not report usage.
- Add `npm run package:all` to validate and build Windows, macOS Apple Silicon, and macOS Intel VSIXs with SHA-256 checksums.

Tool calling requires support from the model server. See the README's self-hosted setup instructions.

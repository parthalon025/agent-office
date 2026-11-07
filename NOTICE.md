# Notices

Agent Office is MIT licensed (see `LICENSE`). Some code was written after reading the code of other MIT projects. This file credits them.

## Paperclip

The providers for Codex, Cursor CLI, Grok CLI and Pi (`src/providers/cli-tools.mjs`, the `codex` entry of `src/providers/acp.mjs`) learn how each tool starts and what it prints from Paperclip's adapters (`packages/adapters/codex-local`, `cursor-local`, `grok-local`, `pi-local`: their `execute.ts`, `parse.ts` and the `codex-acp` start in `acp.ts`). No file was copied. The command lines, the JSON line shapes and the session switches follow what those adapters read.

MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Contributing to Bemor.Flow

Thanks for helping out.

## Reporting a bug
Open an issue and include:
- What you did and what you expected.
- The lines from the **Scanner** box (copy them as text).
- Your Chrome version (`chrome://version`) and whether Flow was in a wide or narrow window.

Flow's page changes often. Most bugs are a button or label that moved, so the exact Scanner message is the most useful thing you can send.

## Working on the code
1. Fork and clone the repo.
2. Load the `extension` folder with **Load unpacked** in `chrome://extensions`.
3. After each change press ↻ on the extension card and reload the Flow tab.

Files:
| File | Role |
|---|---|
| `extension/runner.html`, `runner.js` | The side panel: folders, prompt, naming, run loop, saving. |
| `extension/flow.js` | Content script that drives the Flow page (upload, attach, prompt, generate, collect images). |
| `extension/inject.js` | Runs in the page and hands the file to Flow's upload dialog. |
| `extension/background.js` | Opens the side panel and sends real (trusted) clicks through the debugger API. |

Guidelines:
- Find Flow elements by accessible labels (`aria-label`, visible text), not CSS class names. Class names change with every Flow release.
- Wait for evidence (an element appearing, a new image) rather than fixed delays.
- Keep everything local. No servers, analytics or remote code.
- Test with 1 image before opening a pull request, and describe what you tested.

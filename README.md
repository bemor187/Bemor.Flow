<p align="center"><img src="docs/icon.png" width="96" alt="Bemor.Flow icon"></p>

<h1 align="center">Bemor.Flow</h1>
<p align="center"><b>One prompt. A whole folder of images. Named your way.</b><br>
A free Chrome extension that batch-runs the same Google Flow image edit over every image in a folder and saves the results with your own file names.</p>

<p align="center"><img src="docs/panel.png" width="320" alt="Bemor.Flow side panel"></p>

## What it does
Doing the same edit to 50 images in Google Flow by hand means 50 uploads, 50 prompts, 50 downloads and 50 renames. Bemor.Flow does it for you:

- Picks up every `.jpg`, `.png` or `.webp` in a folder.
- Uploads each one to your Flow project, attaches it, types your prompt and hits Generate.
- Saves the results straight into an output folder using a **naming pattern** you set, like `{base}_wrecked`, `{date}/{base}`, or `alt/{base}_b`.
- Skips images that are already done, so you can stop and resume.

Good for: product photos on a new background, style transfer across a set, game sprite variants (damaged, night, winter), consistent edits over a photo shoot.

## Install (2 minutes)
1. Download this repo: **Code → Download ZIP**, then unzip it.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.
4. Pin Bemor.Flow from the puzzle-piece menu.

Requires Chrome 116 or newer and a Google account with access to [Google Flow](https://labs.google/fx/tools/flow).

## Use it
1. Open a Flow project (`flow.google.com/project/...`) and stay signed in.
2. Click the Bemor.Flow icon. The panel opens beside the Flow tab. **Keep the Flow tab in front** while it runs.
3. **Folders**: choose your source images and where results go.
4. **Prompt**: write one prompt for every image. Start it with `{base}_something:`, because Flow names the image from the start of the prompt.
5. **Naming**: set the file names for the two images Flow returns.
6. **Hit the gas**: test with 1 image first, then raise the count.

### Naming tokens
| Token | Becomes | Example |
|---|---|---|
| `{base}` | source file name without extension | `cat_photo` |
| `{i}` | position in this run | `01`, `02` |
| `{date}` | today, YYYYMMDD | `20261028` |
| `/` | a subfolder | `alt/{base}_b` → `alt/cat_photo_b.jpg` |

The file extension is added automatically. Leave Image 2 blank to keep only the first result.

### Optional: rename map
`extension/renamemap.json` maps a source file name to the name used for `{base}`, e.g. `{"IMG_0042.jpg": "hero_shot.jpg"}`. Leave it as `{}` if you don't need it.

## Things to know
- Every image uses one Flow generation, so it **spends your Flow credits**. Start small.
- Chrome shows a "started debugging this browser" bar during runs. Flow ignores script clicks on Generate, so the extension sends a real click through Chrome's debugger API. It only attaches to the Flow tab, only for that click.
- Everything runs locally in your browser. Nothing is sent anywhere except to Google Flow, by you, in your own session.
- Flow's page changes from time to time. If something stops working, open an issue with the log lines from the Scanner box.
- Unofficial tool, not affiliated with Google. Use it within Google's terms for Flow.

## Roadmap
More features are coming. Ideas and pull requests welcome. Open an issue to suggest one.

## License
MIT. See [LICENSE](LICENSE).

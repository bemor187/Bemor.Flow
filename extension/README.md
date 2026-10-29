# Bemor.Flow

Chrome extension (Manifest V3, load unpacked) that runs **one prompt over a whole folder of images** in
Google Flow and saves every result under a **naming pattern** you choose.

## Setup
1. `chrome://extensions` -> Developer mode -> Load unpacked -> this folder.
2. Open a Flow project (`https://flow.google.com/project/...`) and stay signed in.
3. Click the Bemor.Flow icon. The panel opens in Chrome's side panel next to the Flow tab (keep the Flow tab in front).

## Using it
1. **Folders**: pick the source images (jpg, png, webp) and an output folder.
2. **Prompt**: one prompt for every image. `{base}` is replaced by the source file name without extension.
   Flow names the image from the start of the prompt, so start with `{base}_something:`.
3. **Naming**: patterns for the two images Flow returns.
   - `{base}` source name, `{i}` run number (01, 02...), `{date}` YYYYMMDD, `/` makes a subfolder.
   - The extension (.jpg/.png/.webp) is added from what Flow returns.
   - Leave image 2 blank to save only the first result.
   - Defaults: image 1 `{base}`, image 2 `alt/{base}_b`.
4. **Run**: filter by name, set how many images, cooldown and timeout. Test with 1 image first.
   "Skip images whose result already exists" checks the image 1 name.

Optional `renamemap.json` maps a source file name to the name used for `{base}` (e.g. Flow's own
download names to your own names). Leave it as `{}` if you don't need it.

Each image costs one Flow generation (two images) of credits.

## How it works
- For each image the panel reloads the Flow tab (no leftover ingredient), uploads the source through Flow's
  own upload button (`inject.js` hands the file to the page's file dialog), attaches it as an ingredient,
  types the prompt and clicks Generate.
- Each upload gets a unique name (`<base>_src_<id>.jpg`) so an older upload with the same name is never
  picked by mistake.
- Flow ignores script-made clicks on Generate (and sometimes on fresh picker rows), so `background.js` sends
  real clicks through the debugger protocol (permission `debugger`; Chrome briefly shows "started debugging
  this browser").

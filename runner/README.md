# Bemor.Flow runner

A small local server that feeds a list of jobs to the Bemor.Flow extension (**Job mode**) one at a
time, saves the images it sends back, optionally checks them with a command of your choice, and
writes every state change to `results.json`. Use it to batch prompts from a file without sitting
at the keyboard.

- Node.js only (18 or newer), no npm packages, no accounts, no cloud services.
- Listens on `127.0.0.1` only. Requests from web pages are refused (only the extension and local
  tools can talk to it), and so are requests that name any other host.
- Paces the work like a person would: one job at a time, a random 20-60 s pause between jobs, and
  it stops after 3 failures in a row.
- When the extension reports a sign-in page, a CAPTCHA, an out-of-credits message or a changed
  Flow page, the whole run stops and says so. Nothing tries to get around it.

## Setup
1. Install [Node.js](https://nodejs.org/) 18+.
2. Load the Bemor.Flow extension (see the main README) and open your Flow project in a tab.
3. Write a `jobs.json` (format below).

## Usage
```
node runner/runner.js --jobs jobs.json [--port 8787] [--out DIR] [--gap 20-60] [--check "CMD"]
                      [--job-timeout 900] [--redo] [--ext-id ID] [--mock] [--mock-block KIND]
```
Then in the Bemor.Flow side panel, card **5 Job mode**, press **Start job mode** (same port).

| Option | Meaning |
|---|---|
| `--jobs` | The job file. Relative paths in it are relative to the file. |
| `--port` | Port on 127.0.0.1 (default 8787). |
| `--out` | Output folder; overrides `out_dir` from the job file. |
| `--gap` | Seconds between jobs, `min-max` (default `20-60`). For tests, e.g. `0.2-0.5`. |
| `--check` | Command run on every image; exit code 0 = pass. Tokens: `{file}` `{seamless}` `{size}` `{name}`. If it prints JSON with `reasons` (and `score` or `seam`), those are recorded and the lowest score wins. |
| `--job-timeout` | Seconds without any status from the extension before a job counts as failed (default 900). |
| `--redo` | Run jobs that were already delivered in an earlier run (default: skip them). |
| `--ext-id` | Accept requests only from this extension id (chrome://extensions shows it); default: any extension, never a web page. |
| `--mock` | Built-in fake extension: runs the whole flow offline with small generated test images. |
| `--mock-block KIND` | Fake extension reports `blocked: KIND` on the first job (`signin`, `captcha`, `quota`, `ui-changed`, `setup`). |

Exit code: 0 done, 2 blocked, 3 stopped after 3 consecutive failures, 64 bad arguments.

Example with a checker:
```
node runner/runner.js --jobs tiles.json --check "python -I artcheck.py check {file} --seamless {seamless} --size {size}"
```

## Job file
```json
{
  "set": "my_tiles",
  "out_dir": "out",
  "jobs": [
    {"name": "grass_tile", "prompt": "grass_tile: seamless top-down lawn texture...",
     "count": 2, "inputs": [], "kind": "tile", "seamless": "all", "size": 1024}
  ]
}
```
- `name`: file stem; letters, digits, `_ . -`. Start the prompt with it (Flow names images after the first words).
- `count`: images wanted (1-4). Set Flow's outputs-per-prompt to at least this number.
- `inputs`: empty for **text-to-image**; one image path for **image-to-image** (only the first is attached).
- `seamless`, `size`, `kind`: passed to the `--check` command and recorded.

See `example.jobs.json` (one text-to-image job). For image-to-image, put a picture next to the jobs file and list it in `inputs`.

## States (`results.json`)
`queued` -> `running` -> `downloaded` -> `checked` (`pass: ...` / `fail: ...`) -> `delivered`, or
`failed` (the extension reported an error). Blocking states stop the run:
`blocked: signin`, `blocked: captcha`, `blocked: quota`, `blocked: ui-changed`, `blocked: setup`
(no Flow project tab open). Every transition is kept with a timestamp in the job's `history`.
`run_state` is `running`, `done`, `blocked: <kind>` or `stopped: 3 consecutive failures`.

## HTTP API (127.0.0.1 only)
| Request | Answer |
|---|---|
| `GET /hello` | `{app, version, set, run_state}` |
| `GET /next` | `{job: {...}}`, `{wait: ms}` (pause or a job is running), or `{done: true, run_state}` |
| `POST /status` (JSON) | `{name, state, detail, files}`; `state` is `running`, `progress`, `downloaded` (with `files: [{k, type, b64}]`), `failed` or `blocked: <kind>` |
| `GET /input?name=N&i=0` | the job's input image (only files listed in the job file) |
| `GET /results` | the current `results.json` |

## Files it reads and writes
- Reads: the job file and the input images it lists; an existing `results.json` / `manifest.json` in the output folder (to skip delivered jobs and keep attempt counts).
- Writes, all inside the output folder:
  - `_candidates/<name>_<k>.png`: every image the extension sent.
  - `<name>.png`: the delivered image (the best passing candidate).
  - `results.json`: states and history of this run (the previous one moves to `_old/`).
  - `manifest.json`: per job: prompt, attempts, chosen candidate, checks, date.
  - `_old/`: any candidate, delivered image or `results.json` that would be replaced is moved here first, with a timestamp. Nothing is deleted. (`manifest.json` is the run log and is updated in place.)
- Network: listens on 127.0.0.1 only; makes no outgoing connections (the mock client talks to the runner itself).
